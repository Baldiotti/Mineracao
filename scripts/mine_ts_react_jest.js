/* scripts/mine_ts_react_jest.js */
/* Node 18+ (fetch nativo). Execute: `node scripts/mine_ts_react_jest.js` */

'use strict';

const fs = require('fs');
const path = require('path');

// =========================
// Config
// =========================
const OUTPUT_DIR = 'output';
const CSV_FILE = path.join(OUTPUT_DIR, 'repos_ts_react_jest.csv');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10); // por página (REST: per_page máx 100)
const SLEEP_BETWEEN_PAGES_MS = parseInt(
  process.env.SLEEP_BETWEEN_PAGES_MS || '800',
  10
);

// Limites globais
const MAX_QUALIFIED = parseInt(process.env.MAX_QUALIFIED || '1000', 10);
const MAX_ANALYZED = parseInt(process.env.MAX_ANALYZED || '0', 10); // 0 = ilimitado

// Filtros
const REQUIRE_FRONTEND_TESTS =
  (process.env.REQUIRE_FRONTEND_TESTS || 'true').toLowerCase() === 'true';
const EXCLUDE_COURSE_BOILERPLATE =
  (process.env.EXCLUDE_COURSE_BOILERPLATE || 'true').toLowerCase() === 'true';
const README_COURSE_CHECK =
  (process.env.README_COURSE_CHECK || 'false').toLowerCase() === 'true';

// Exclusões por tópico na query (menos agressivo; deixe vazio se quiser nenhuma)
// Por padrão deixo vazio para evitar “zerar” a busca. Ajuste se quiser.
const EXCLUDE_TOPICS = (process.env.EXCLUDE_TOPICS || '').trim(); // ex: '-topic:template -topic:boilerplate'

// Trimestres
const QUARTERS_COUNT = parseInt(process.env.QUARTERS_COUNT || '20', 10);

// Token
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || process.env.PAT || process.env.GH_TOKEN;

if (!GITHUB_TOKEN) {
  console.error('Erro: GITHUB_TOKEN não encontrado.');
  process.exit(1);
}

// Finalização graciosa ao receber sinais (ex.: cancelamento do job)
let stopRequested = false;
process.on('SIGTERM', () => {
  stopRequested = true;
});
process.on('SIGINT', () => {
  stopRequested = true;
});

// =========================
// Util
// =========================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureOutput() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function writeCsvHeaderIfNeeded() {
  ensureOutput();
  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(
      CSV_FILE,
      'Repositorio,Link,Estrelas,TypeScript,React,Jest,FrontendTestLibs\n',
      'utf-8'
    );
  }
}

function appendCsvRow({
  nameWithOwner,
  stars,
  hasTS,
  hasReact,
  hasJest,
  feLibs,
}) {
  const libs = (feLibs || []).join('|');
  const link = `https://github.com/${nameWithOwner}`;
  const line = `${nameWithOwner},${link},${stars},${hasTS ? 'Sim' : 'Não'},${
    hasReact ? 'Sim' : 'Não'
  },${hasJest ? 'Sim' : 'Não'},${libs}\n`;
  fs.appendFileSync(CSV_FILE, line);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {}),
      },
    });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function handleRateLimit(res) {
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === '0' && reset) {
      const waitMs =
        Math.max(0, parseInt(reset, 10) * 1000 - Date.now()) + 5000;
      console.warn(
        `Rate limit atingido. Aguardando ${(waitMs / 1000).toFixed(0)}s...`
      );
      await sleep(waitMs);
      return true;
    }
  }
  return false;
}

async function ghGET(url) {
  while (true) {
    const res = await fetchWithTimeout(url, { method: 'GET' });
    if (res.status === 403) {
      const retry = await handleRateLimit(res);
      if (retry) continue;
    }
    if (res.status === 404) return { status: 404 };
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(
        `GET ${url} falhou: ${res.status} - ${res.statusText} - ${txt.slice(
          0,
          300
        )}`
      );
    }
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
}

// =========================
// Detecção tech
// =========================
async function getRepoLanguages(owner, repo) {
  const { status, data } = await ghGET(
    `https://api.github.com/repos/${owner}/${repo}/languages`
  );
  if (status !== 200 || !data) return {};
  return data;
}

async function getRepoTopics(owner, repo) {
  const { status, data } = await ghGET(
    `https://api.github.com/repos/${owner}/${repo}/topics`
  );
  if (status !== 200 || !data) return [];
  return Array.isArray(data.names) ? data.names : [];
}

async function getRepoContent(owner, repo, pathName) {
  const { status, data } = await ghGET(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
      pathName
    )}`
  );
  if (status !== 200 || !data) return null;
  if (data.encoding === 'base64' && data.content) {
    try {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      return decoded;
    } catch {
      return null;
    }
  }
  return null;
}

function hasDep(pkgJson, name) {
  const deps = pkgJson?.dependencies || {};
  const dev = pkgJson?.devDependencies || {};
  return Boolean(deps[name] || dev[name]);
}

function pkgHasAnyDep(pkgJson, names) {
  return names.some((n) => hasDep(pkgJson, n));
}

function scriptsContain(pkgJson, substrings) {
  const scripts = pkgJson?.scripts || {};
  const values = Object.values(scripts)
    .filter((s) => typeof s === 'string')
    .map((s) => s.toLowerCase());
  return substrings.some((sub) => values.some((s) => s.includes(sub)));
}

// Apenas Jest e Testing Library contam
function detectFrontendFromPkg(pkgJson) {
  const libs = [];
  const hasJest =
    pkgHasAnyDep(pkgJson, ['jest', '@jest/globals', 'ts-jest', 'babel-jest']) ||
    scriptsContain(pkgJson, ['jest']);
  const hasRTL = pkgHasAnyDep(pkgJson, [
    '@testing-library/react',
    '@testing-library/jest-dom',
    '@testing-library/user-event',
  ]);

  if (hasRTL) libs.push('testing-library');
  if (hasJest) libs.push('jest');

  const hasFrontendTests = hasJest || hasRTL;
  return { hasFrontendTests, libs, hasJest };
}

async function detectTech(owner, repo) {
  let hasTS = false;
  let hasReact = false;
  let hasJest = false;
  let hasFrontendTests = false;
  let feLibs = [];
  let topics = [];

  const langs = await getRepoLanguages(owner, repo).catch(() => ({}));
  if (langs && typeof langs.TypeScript === 'number' && langs.TypeScript > 0)
    hasTS = true;

  const pkgText = await getRepoContent(owner, repo, 'package.json');
  let pkgJson = null;
  if (pkgText) {
    try {
      pkgJson = JSON.parse(pkgText);
    } catch {}
  }

  if (pkgJson) {
    if (pkgHasAnyDep(pkgJson, ['react', 'react-dom'])) hasReact = true;
    if (!hasTS && pkgHasAnyDep(pkgJson, ['typescript'])) hasTS = true;

    const fe = detectFrontendFromPkg(pkgJson);
    hasFrontendTests = fe.hasFrontendTests;
    feLibs = fe.libs;
    hasJest = fe.hasJest;
  }

  topics = await getRepoTopics(owner, repo).catch(() => []);
  if (!hasReact && topics.map((t) => t.toLowerCase()).includes('react'))
    hasReact = true;

  if (!hasTS) {
    const tsconfig = await getRepoContent(owner, repo, 'tsconfig.json');
    const tsconfigBase = tsconfig
      ? null
      : await getRepoContent(owner, repo, 'tsconfig.base.json');
    if (tsconfig || tsconfigBase) hasTS = true;
  }

  if (!hasJest) {
    const candidates = [
      'jest.config.js',
      'jest.config.cjs',
      'jest.config.mjs',
      'jest.config.ts',
      'jest.config.json',
    ];
    for (const file of candidates) {
      const content = await getRepoContent(owner, repo, file);
      if (content) {
        hasJest = true;
        break;
      }
    }
    if (hasJest && !feLibs.includes('jest')) feLibs.push('jest');
  }

  if (!hasFrontendTests && hasJest) hasFrontendTests = true;

  return { hasTS, hasReact, hasJest, hasFrontendTests, feLibs, topics };
}

// =========================
// Curso/Boilerplate/Template
// =========================
const COURSE_KEYWORDS_DEFAULT = [
  'curso',
  'course',
  'udemy',
  'alura',
  'rocketseat',
  'bootcamp',
  'treinamento',
  'tutorial',
  'aula',
  'aulas',
  'exercicio',
  'exercício',
  'exercicios',
  'exercícios',
  'learn',
  'learning',
  'education',
  'formacao',
  'formação',
  'nanodegree',
  'codecademy',
  'freecodecamp',
];

const BOILERPLATE_KEYWORDS_DEFAULT = [
  'boilerplate',
  'starter',
  'starter-kit',
  'seed',
  'scaffold',
  'skeleton',
  'quickstart',
  'template',
  'templates',
];

const EXTRA_COURSE_KEYWORDS = (process.env.COURSE_KEYWORDS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const EXTRA_BOILERPLATE_KEYWORDS = (process.env.BOILERPLATE_KEYWORDS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function textIncludesAny(haystack, keywords) {
  const lc = (haystack || '').toLowerCase();
  return keywords.some((k) => lc.includes(k));
}

async function getRepoReadme(owner, repo) {
  const { status, data } = await ghGET(
    `https://api.github.com/repos/${owner}/${repo}/readme`
  );
  if (status !== 200 || !data) return '';
  if (data.encoding === 'base64' && data.content) {
    try {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
  return '';
}

async function detectCourseOrBoilerplate(
  owner,
  repo,
  name,
  description,
  topics
) {
  const courseKeywords = [...COURSE_KEYWORDS_DEFAULT, ...EXTRA_COURSE_KEYWORDS];
  const boilerKeywords = [
    ...BOILERPLATE_KEYWORDS_DEFAULT,
    ...EXTRA_BOILERPLATE_KEYWORDS,
  ];

  const nameStr = (name || '').toLowerCase();
  const descStr = (description || '').toLowerCase();
  const topicsStr = (topics || []).map((t) => t.toLowerCase()).join(' ');

  let isCourse =
    textIncludesAny(nameStr, courseKeywords) ||
    textIncludesAny(descStr, courseKeywords) ||
    textIncludesAny(topicsStr, courseKeywords);
  let isBoilerOrTemplate =
    textIncludesAny(nameStr, boilerKeywords) ||
    textIncludesAny(descStr, boilerKeywords) ||
    textIncludesAny(topicsStr, boilerKeywords);

  if (!isCourse && !isBoilerOrTemplate && README_COURSE_CHECK) {
    const readme = await getRepoReadme(owner, repo).catch(() => '');
    const readme2k = (readme || '').slice(0, 4000).toLowerCase();
    if (textIncludesAny(readme2k, courseKeywords)) isCourse = true;
    if (textIncludesAny(readme2k, boilerKeywords)) isBoilerOrTemplate = true;
  }

  return { isCourseOrBoilerplate: isCourse || isBoilerOrTemplate };
}

// =========================
// Busca via REST /search/repositories com pushed por trimestre
// =========================
function buildLastNQuarters(n) {
  const ranges = [];
  const now = new Date();
  const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3; // 0,3,6,9
  let cur = new Date(Date.UTC(now.getUTCFullYear(), qStartMonth, 1));

  for (let i = 0; i < n; i++) {
    const y = cur.getUTCFullYear();
    const m0 = cur.getUTCMonth(); // 0,3,6,9
    const qEndMonth = m0 + 2; // 2,5,8,11
    const lastDay = new Date(Date.UTC(y, qEndMonth + 1, 0)).getUTCDate();
    const start = `${y}-${String(m0 + 1).padStart(2, '0')}-01`;
    const finish = `${y}-${String(qEndMonth + 1).padStart(2, '0')}-${String(
      lastDay
    ).padStart(2, '0')}`;
    ranges.push(`pushed:${start}..${finish}`);
    cur = new Date(Date.UTC(y, m0 - 3, 1)); // volta 1 trimestre
  }
  return ranges;
}

// Bases amplas (TS + React); Jest/RTL é validado no código
const BASES = [
  'language:TypeScript react',
  'language:TypeScript topic:react',
  'language:TypeScript "react" in:name,description,readme',
];

function buildQueries() {
  const quarters = buildLastNQuarters(QUARTERS_COUNT);
  const queries = [];
  const excl = EXCLUDE_TOPICS; // ex: '-topic:template -topic:boilerplate'
  for (const base of BASES) {
    for (const pushed of quarters) {
      const q = [base, pushed, 'fork:false', 'archived:false', excl]
        .filter(Boolean)
        .join(' ')
        .trim();
      queries.push(q);
    }
  }
  return queries;
}

async function searchReposREST(query, page, perPage) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query
  )}&per_page=${perPage}&page=${page}`;
  const { status, data } = await ghGET(url);
  if (status !== 200 || !data) return { total_count: 0, items: [] };
  return { total_count: data.total_count || 0, items: data.items || [] };
}

// =========================
// Main
// =========================
async function main() {
  writeCsvHeaderIfNeeded();

  const processed = new Set();
  let totalQualified = 0;
  let reachedLimit = false;

  const queries = buildQueries();
  console.log(`Queries geradas: ${queries.length}`);
  if (queries.length > 0) console.log(`Exemplo de query[0]: ${queries[0]}`);

  for (const q of queries) {
    if (reachedLimit || stopRequested) break;

    console.log(`\n🔎 Query: ${q}`);
    let page = 1;

    while (!reachedLimit && !stopRequested) {
      let result;
      try {
        result = await searchReposREST(q, page, BATCH_SIZE);
      } catch (e) {
        console.error(`❌ Erro na busca REST: ${e.message}`);
        break;
      }

      const items = result.items || [];
      console.log(
        `📈 total_count≈${result.total_count} | página=${page} | itens=${items.length}`
      );

      if (items.length === 0) break;

      for (const it of items) {
        if (reachedLimit || stopRequested) break;
        const nameWithOwner = it.full_name; // 'owner/repo'

        if (processed.has(nameWithOwner)) continue;
        processed.add(nameWithOwner);

        if (MAX_ANALYZED > 0 && processed.size >= MAX_ANALYZED) {
          console.log(`Atingiu MAX_ANALYZED=${MAX_ANALYZED}. Finalizando...`);
          reachedLimit = true;
          break;
        }

        console.log(
          `🔍 Analisando: ${nameWithOwner} (${it.stargazers_count}⭐)`
        );

        try {
          const tech = await detectTech(it.owner.login, it.name);
          const courseFlag = await detectCourseOrBoilerplate(
            it.owner.login,
            it.name,
            it.name,
            it.description,
            tech.topics
          );

          if (EXCLUDE_COURSE_BOILERPLATE && courseFlag.isCourseOrBoilerplate) {
            console.log(
              `⏭️ Excluído por curso/boilerplate/template: ${nameWithOwner}`
            );
            continue;
          }

          if (!(tech.hasTS && tech.hasReact)) {
            console.log(
              `❌ Falta TS ou React (TS:${tech.hasTS} React:${tech.hasReact}): ${nameWithOwner}`
            );
            continue;
          }

          if (REQUIRE_FRONTEND_TESTS && !tech.hasFrontendTests) {
            console.log(
              `❌ Sem testes de front-end (Jest/Testing Library) detectados: ${nameWithOwner}`
            );
            continue;
          }

          appendCsvRow({
            nameWithOwner,
            stars: it.stargazers_count,
            hasTS: tech.hasTS,
            hasReact: tech.hasReact,
            hasJest: tech.hasJest,
            feLibs: tech.feLibs,
          });

          totalQualified++;
          console.log(
            `✅ Registrado: ${nameWithOwner} | Total qualificados: ${totalQualified}`
          );

          if (totalQualified >= MAX_QUALIFIED) {
            console.log(
              `Atingiu MAX_QUALIFIED=${MAX_QUALIFIED}. Finalizando...`
            );
            reachedLimit = true;
            break;
          }
        } catch (err) {
          console.warn(`⚠️ Falha ao analisar ${nameWithOwner}: ${err.message}`);
        }
      }

      if (reachedLimit || stopRequested) break;

      // Search API tem teto de 1000 resultados por query (10 páginas de 100)
      const maxPages = Math.ceil(
        Math.min(result.total_count, 1000) / BATCH_SIZE
      );
      if (page >= maxPages) {
        console.log('🏁 Fim da paginação desta query (limite da Search API).');
        break;
      }
      page += 1;
      await sleep(SLEEP_BETWEEN_PAGES_MS);
    }

    console.log('📊 Query finalizada.');
    await sleep(600);
  }

  console.log('\n🎉 ===== RESUMO =====');
  console.log(`🔢 Repositórios únicos analisados: ${processed.size}`);
  console.log(`✅ Repositórios mantidos (pós-filtros): ${totalQualified}`);
  console.log(`📁 CSV gerado: ${CSV_FILE}`);
}

main().catch((e) => {
  console.error('Erro fatal:', e);
  process.exit(1);
});
