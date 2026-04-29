const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { google } = require('googleapis');

const TIKTOK_USERNAME = (process.env.TIKTOK_USERNAME || '').replace(/^@/, '');
const DRIVE_FOLDER_ID = (process.env.DRIVE_FOLDER_ID || '').trim();
const OAUTH_CLIENT_ID = (process.env.OAUTH_CLIENT_ID || '').trim();
const OAUTH_CLIENT_SECRET = (process.env.OAUTH_CLIENT_SECRET || '').trim();
const OAUTH_REFRESH_TOKEN = (process.env.OAUTH_REFRESH_TOKEN || '').trim();
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '5', 10);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_FILE = path.join(REPO_ROOT, '.tiktok-state.json');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    const stderr = (res.stderr || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}: ${stderr}`);
  }
  return res.stdout;
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds : [] };
  } catch {
    return { seenIds: [] };
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function listProfileVideos(username) {
  const url = `https://www.tiktok.com/@${username}`;
  const out = run('yt-dlp', [
    '--flat-playlist',
    '--print', '%(id)s\t%(upload_date)s\t%(title).200s',
    '--playlist-end', '50',
    url,
  ]);
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [id, uploadDate, ...rest] = line.split('\t');
      return { id, uploadDate: uploadDate || 'unknown', title: rest.join('\t') };
    });
}

function downloadVideo(username, videoId, destDir) {
  const url = `https://www.tiktok.com/@${username}/video/${videoId}`;
  run('yt-dlp', [
    '-o', path.join(destDir, '%(id)s.%(ext)s'),
    '--no-playlist',
    '--no-progress',
    '--quiet',
    '--restrict-filenames',
    url,
  ]);
  const files = fsSync.readdirSync(destDir).filter(f => f.startsWith(videoId));
  if (files.length === 0) throw new Error(`yt-dlp produced no file for ${videoId}`);
  return path.join(destDir, files[0]);
}

async function uploadToDrive(drive, localPath, driveFilename) {
  const mimeType = localPath.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream';
  const res = await drive.files.create({
    requestBody: {
      name: driveFilename,
      parents: [DRIVE_FOLDER_ID],
    },
    media: {
      mimeType,
      body: fsSync.createReadStream(localPath),
    },
    fields: 'id, name',
    supportsAllDrives: true,
  });
  return res.data;
}

function makeDriveClient() {
  const oauth2 = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth2 });
}

async function main() {
  if (!TIKTOK_USERNAME) throw new Error('TIKTOK_USERNAME is required');
  if (!DRIVE_FOLDER_ID) throw new Error('DRIVE_FOLDER_ID is required');
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !OAUTH_REFRESH_TOKEN) {
    throw new Error('OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, and OAUTH_REFRESH_TOKEN are all required');
  }

  const state = await readState();
  const seen = new Set(state.seenIds);

  console.log(`Listing videos for @${TIKTOK_USERNAME}…`);
  const videos = listProfileVideos(TIKTOK_USERNAME);
  console.log(`Found ${videos.length} videos on profile.`);

  const newOnes = videos.filter(v => !seen.has(v.id)).slice(0, MAX_PER_RUN);
  if (newOnes.length === 0) {
    console.log('No new videos.');
    return;
  }
  console.log(`Will process ${newOnes.length} new video(s).`);

  const drive = makeDriveClient();

  try {
    const about = await drive.about.get({ fields: 'user(emailAddress)' });
    console.log(`Authenticated as: ${about.data.user?.emailAddress || '(unknown)'}`);
  } catch (err) {
    console.error(`drive.about.get failed: ${err.message}`);
  }

  try {
    const meta = await drive.files.get({
      fileId: DRIVE_FOLDER_ID,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });
    console.log(`Drive folder OK: "${meta.data.name}" (id=${meta.data.id})`);
  } catch (err) {
    console.error(`Cannot read DRIVE_FOLDER_ID: ${err.message}`);
    throw err;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiktok-'));

  for (const video of newOnes) {
    try {
      console.log(`→ Downloading ${video.id} (${video.uploadDate})`);
      const localPath = downloadVideo(TIKTOK_USERNAME, video.id, tmpDir);
      const driveName = `${video.uploadDate}_${video.id}.mp4`;
      console.log(`  Uploading as ${driveName}`);
      const uploaded = await uploadToDrive(drive, localPath, driveName);
      console.log(`  Drive id: ${uploaded.id}`);
      seen.add(video.id);
      await fs.unlink(localPath).catch(() => {});
    } catch (err) {
      console.error(`  Failed for ${video.id}: ${err.message}`);
    }
  }

  state.seenIds = Array.from(seen);
  await writeState(state);
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
