const fs = require('node:fs/promises');
const path = require('node:path');
const TurndownService = require('turndown');

const WP_HOST = process.env.WP_HOST || 'gamefolio.gg';
const WP_USERNAME = process.env.WP_USERNAME || '';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || '';
const API_URL = `https://${WP_HOST}/wp-json/wp/v2/posts?_embed&per_page=50&orderby=date&order=desc`;

const BASIC_AUTH = WP_USERNAME && WP_APP_PASSWORD
  ? 'Basic ' + Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64')
  : '';

function authHeadersFor(url) {
  if (!BASIC_AUTH) return {};
  try {
    if (new URL(url).host === WP_HOST) return { Authorization: BASIC_AUTH };
  } catch {}
  return {};
}

const ALLOWED_CATEGORIES = ['Indie games', 'Streaming', 'Gaming news', 'web3', 'Crypto', 'Community'];
const FALLBACK_CATEGORY = 'Gaming news';
const AUTHOR = 'Tom Watts';
const AUTHOR_TWITTER = '@w0tts';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POSTS_JSON = path.join(REPO_ROOT, 'posts.json');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripHtml(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function pickCategory(post) {
  const groups = post._embedded?.['wp:term'] ?? [];
  for (const group of groups) {
    for (const term of group) {
      if (term.taxonomy === 'category') {
        const match = ALLOWED_CATEGORIES.find(c => c.toLowerCase() === term.name.toLowerCase());
        if (match) return match;
      }
    }
  }
  return FALLBACK_CATEGORY;
}

function readTime(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return `${minutes} min read`;
}

function extOf(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext && ext.length <= 5 ? ext : '.jpg';
  } catch {
    return '.jpg';
  }
}

async function downloadImage(url, destDir, baseName) {
  await fs.mkdir(destDir, { recursive: true });
  const filename = `${baseName}${extOf(url)}`;
  const res = await fetch(url, { headers: authHeadersFor(url) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(path.join(destDir, filename), buf);
  return filename;
}

async function processPost(post) {
  const slug = post.slug;
  const title = decodeEntities(post.title.rendered);
  const excerpt = stripHtml(post.excerpt.rendered);
  const publishedAt = post.date.slice(0, 10);
  const category = pickCategory(post);
  const slugAssets = path.join(ASSETS_DIR, slug);

  let imageEntry = null;
  const featured = post._embedded?.['wp:featuredmedia']?.[0];
  const featuredUrl = featured?.media_details?.sizes?.full?.source_url || featured?.source_url;
  if (featuredUrl) {
    try {
      const filename = await downloadImage(featuredUrl, slugAssets, 'cover');
      imageEntry = {
        type: 'local',
        src: `./assets/${slug}/${filename}`,
        alt: featured.alt_text || title,
      };
    } catch (err) {
      console.warn(`[${slug}] featured image failed: ${err.message}`);
    }
  }

  let html = post.content.rendered.replace(/<!--[\s\S]*?-->/g, '');

  const srcs = [];
  const seen = new Set();
  const imgRegex = /<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      srcs.push(m[1]);
    }
  }
  let counter = 0;
  for (const src of srcs) {
    counter += 1;
    try {
      const filename = await downloadImage(src, slugAssets, `inline-${counter}`);
      html = html.split(src).join(`/assets/${slug}/${filename}`);
    } catch (err) {
      console.warn(`[${slug}] inline image failed for ${src}: ${err.message}`);
    }
  }

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '*',
    emDelimiter: '_',
  });
  const markdown = turndown.turndown(html).trim() + '\n';

  await fs.writeFile(path.join(REPO_ROOT, `${slug}.md`), markdown);

  return {
    slug,
    title,
    excerpt,
    author: AUTHOR,
    authorTwitter: AUTHOR_TWITTER,
    publishedAt,
    category,
    featured: false,
    image: imageEntry,
    readTime: readTime(stripHtml(post.content.rendered)),
  };
}

async function main() {
  const posts = JSON.parse(await fs.readFile(POSTS_JSON, 'utf8'));
  const knownSlugs = new Set(posts.map(p => p.slug));

  const res = await fetch(API_URL, { headers: authHeadersFor(API_URL) });
  if (!res.ok) throw new Error(`WP API error: ${res.status} ${res.statusText}`);
  const wpPosts = await res.json();

  const newEntries = [];
  for (const post of wpPosts) {
    if (knownSlugs.has(post.slug)) continue;
    try {
      const entry = await processPost(post);
      newEntries.push(entry);
      knownSlugs.add(entry.slug);
      console.log(`Imported: ${entry.slug}`);
    } catch (err) {
      console.error(`Failed: ${post.slug}: ${err.message}`);
    }
  }

  if (newEntries.length === 0) {
    console.log('No new posts.');
    return;
  }

  const merged = [...newEntries, ...posts];
  await fs.writeFile(POSTS_JSON, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Added ${newEntries.length} post(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
