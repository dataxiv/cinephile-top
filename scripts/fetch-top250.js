const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://www.imdb.com/chart/top/';
const SOURCE_NAME = 'imdb';
const SAVE_NAME = `movie-${SOURCE_NAME}-top250`;

function toBeijingISO(date) {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const Y = shifted.getUTCFullYear();
  const M = pad(shifted.getUTCMonth() + 1);
  const D = pad(shifted.getUTCDate());
  const h = pad(shifted.getUTCHours());
  const m = pad(shifted.getUTCMinutes());
  const s = pad(shifted.getUTCSeconds());
  return `${Y}-${M}-${D}T${h}:${m}:${s}+0800`;
}

function mapMovie(edge) {
  const node = edge.node;
  const displayTitle = node.titleText?.text ?? '';
  const originalTitle = node.originalTitleText?.text;
  const names = originalTitle && originalTitle !== displayTitle ? [originalTitle] : [];
  const certificate = node.certificate?.rating;

  const movie = {
    item_type: node.titleType?.text || 'Movie',
    id: node.id,
    rank: edge.currentRank,
    name: displayTitle,
    names,
    links: [`https://www.imdb.com/title/${node.id}/`],
    covers: node.primaryImage?.url ? [node.primaryImage.url] : [],
    year: node.releaseYear?.year ?? null,
    publish: node.releaseDate
      ? { year: node.releaseDate.year, month: node.releaseDate.month, day: node.releaseDate.day }
      : null,
    score: node.ratingsSummary?.aggregateRating ?? null,
    vote: node.ratingsSummary?.voteCount ?? null,
    genres: (node.titleGenres?.genres || []).map((g) => g.genre.text),
    summary: node.plot?.plotText?.plainText ?? '',
  };
  if (certificate) movie.certificate = certificate;
  movie.duration = node.runtime?.seconds ?? null;
  movie.ext = { is_ratable: !!node.canRate?.isRatable };
  return movie;
}

function genreStats(movies) {
  const counts = new Map();
  for (const m of movies) {
    for (const g of m.genres) {
      counts.set(g, (counts.get(g) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const stats = {};
  for (const [genre, count] of sorted) stats[genre] = count;
  return stats;
}

async function fetchTop250() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    const page = await context.newPage();

    // avoid 202 status
    const response = await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = response?.status();
    const pageState = await page.evaluate(() => {
      const nextData = document.getElementById('__NEXT_DATA__');
      return {
        title: document.title,
        bodyText: document.body?.innerText?.trim().slice(0, 500) || '',
        hasNextData: !!nextData,
      };
    });

    if (status && status >= 400) {
      throw new Error(
        `IMDb returned HTTP ${status} for ${SOURCE_URL}. The page cannot be parsed as Top 250 data.`,
      );
    }

    if (/human verification/i.test(pageState.title) || /confirm you are human/i.test(pageState.bodyText)) {
      throw new Error(
        `IMDb returned a human verification page for ${SOURCE_URL}. Run with a verified browser session or use another data source.`,
      );
    }

    if (status === 202 && !pageState.hasNextData) {
      throw new Error(
        `IMDb returned HTTP 202 without __NEXT_DATA__ for ${SOURCE_URL}.`,
      );
    }

    if (!pageState.hasNextData) {
      throw new Error(
        `IMDb page did not include __NEXT_DATA__ for ${SOURCE_URL}. Page title: ${JSON.stringify(pageState.title)}.`,
      );
    }

    await page.waitForFunction(
      () => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return false;
        try {
          const data = JSON.parse(el.textContent);
          const edges = data?.props?.pageProps?.pageData?.chartTitles?.edges;
          return Array.isArray(edges) && edges.length >= 250;
        } catch {
          return false;
        }
      },
      { timeout: 30000, polling: 500 },
    );

    const { edges, descText } = await page.evaluate(() => {
      const nextData = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
      const bottom = document.querySelector('[data-testid="chart-layout-bottom-content"]');
      return {
        edges: nextData.props.pageProps.pageData.chartTitles.edges,
        descText: bottom ? bottom.innerText.trim() : '',
      };
    });
    const normalizedDesc = descText.replace(/\n{2,}/g, '\n');

    return { edges, descText: normalizedDesc };
  } finally {
    await browser.close();
  }
}

async function main() {
  const releaseTime = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const monthStamp = `${releaseTime.getFullYear()}${pad(releaseTime.getMonth() + 1)}`;
  const dateStamp = `${monthStamp}${pad(releaseTime.getDate())}`;
  const outDir = path.join(__dirname, '..', SOURCE_NAME, monthStamp);
  const outPath = path.join(outDir, `${SAVE_NAME}-${dateStamp}.json`);

  if (fs.existsSync(outPath)) {
    console.log(`${outPath} already exists, skipping fetch`);
    return;
  }

  const { edges, descText } = await fetchTop250();
  const updateTime = new Date();

  const movies = edges.map(mapMovie);

  const result = {
    release_time: toBeijingISO(releaseTime),
    update_time: toBeijingISO(updateTime),
    description: {
      title: 'IMDb Top 250 movies',
      subtitle: '',
      source: SOURCE_URL,
      link: null,
      page_start: 1,
      page_end: 1,
      page_total: 1,
      page_limit: -1,
      item_total: movies.length,
      item_limit: 250,
      page_count: 1,
      sup_page_count: 0,
    },
    extra: {
      timestamp: releaseTime.toISOString(),
      desc: descText,
      stats: genreStats(movies),
    },
    stats: { movies: movies.length },
    movies,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');

  console.log(`Wrote ${movies.length} movies to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
