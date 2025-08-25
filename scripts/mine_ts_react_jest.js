/* scripts/mine_ts_react_jest.js */
/* Node 18+ (fetch nativo). Execute: `node scripts/mine_ts_react_jest.js` */

'use strict';

const fs = require('fs');
const path = require('path');

// =========================
// Configurações principais
// =========================
const OUTPUT_DIR = 'output';
const CSV_FILE = path.join(OUTPUT_DIR, 'repos_ts_react_jest.csv');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10); // 1..100 por página GraphQL
const SLEEP_BETWEEN_PAGES_MS = parseInt(
  process.env.SLEEP_BETWEEN_PAGES_MS || '1000',
  10
); // pausa entre páginas

// Limites globais (env):
// - MAX_QUALIFIED: quantos repositórios que ATENDEM ao critério antes de parar
// - MAX_ANALYZED: total de repositórios analisados (0 = ilimitado)
const MAX_QUALIFIED = parseInt(process.env.MAX_QUALIFIED || '1000', 10);
const MAX_ANALYZED = parseInt(process.env.MAX_ANALYZED || '0', 10);

// Filtros (env):
// - REQUIRE_FRONTEND_TESTS: manter apenas repos com testes front-end (Jest e/ou Testing Library)
const REQUIRE_FRONTEND_TESTS =
  (process.env.REQUIRE_FRONTEND_TESTS || 'true').toLowerCase() === 'true';
// - EXCLUDE_COURSE_BOILERPLATE: excluir cursos/boilerplates/templates
const EXCLUDE_COURSE_BOILERPLATE =
  (process.env.EXCLUDE_COURSE_BOILERPLATE || 'true').toLowerCase() === 'true';
// - README_COURSE_CHECK: se true, lê README para detectar curso/boilerplate/template (mais requests)
const README_COURSE_CHECK =
  (process.env.README_COURSE_CHECK || 'false').toLowerCase() === 'true';

// Palavras-chave extras via env (separadas por vírgula)
const EXTRA_COURSE_KEYWORDS = (process.env.COURSE_KEYWORDS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const EXTRA_BOILERPLATE_KEYWORDS = (process.env.BOILERPLATE_KEYWORDS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Sharding por trimestres (últimos N trimestres a partir de hoje)
const QUARTERS_COUNT = parseInt(process.env.QUARTERS_COUNT || '20', 10);

// Finalização graciosa ao receber sinais (ex.: cancelamento do job)
let stopRequested = false;
process.on('SIGTERM', () => {
  stopRequested = true;
});
process.on('SIGINT', () => {
  stopRequested = true;
});

// Token (Actions injeta GITHUB_TOKEN automaticamente)
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || process.env.PAT || process.env.GH_TOKEN;

if (!GITHUB_TOKEN) {
  console.error(
    'Erro: GITHUB_TOKEN não encontrado. No Actions, use secrets.GITHUB_TOKEN. Local: exporte GITHUB_TOKEN.'
  );
  process.exit(1);
}

// =========================
// Utilitários
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
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function handleRateLimit(res) {
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === '0' && reset) {
      const resetEpoch = parseInt(reset, 10) * 1000;
      const waitMs = Math.max(0, resetEpoch - Date.now()) + 5000;
      console.warn(
        `Rate limit atingido. Aguardando ${(waitMs / 1000).toFixed(0)}s...`
      );
      await sleep(waitMs);
      return true; // tentar novamente
    }
  }
  return false;
}

async function ghGraphQL(query, variables) {
  while (true) {
    const res = await fetchWithTimeout('https://api.github.com/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: { 'Content-Type': 'application/json' },
    });

    if (res.status === 403) {
      const willRetry = await handleRateLimit(res);
      if (willRetry) continue;
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(
        `GraphQL falhou: ${res.status} - ${res.statusText} - ${txt.slice(
          0,
          500
        )}`
      );
    }

    const json = await res.json();
    if (json.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }
}

async function ghGET(url) {
  while (true) {
    const res = await fetchWithTimeout(url, { method: 'GET' });

    if (res.status === 403) {
      const willRetry = await handleRateLimit(res);
      if (willRetry) continue;
    }

    if (res.status === 404) return { status: 404 };
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(
        `GET ${url} falhou: ${res.status} - ${res.statusText} - ${txt.slice(
          0,
          500
        )}`
      );
    }

    const json = await res.json().catch(() => null);
    return { status: res.status, data: json };
  }
}

// =========================
/* Detecção de tecnologias e metadados */
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
  const deps = pkgJson.dependencies || {};
  const dev = pkgJson.devDependencies || {};
  return Boolean(deps[name] || dev[name]);
}

function pkgHasAnyDep(pkgJson, names) {
  return names.some((n) => hasDep(pkgJson, n));
}

function scriptsContain(pkgJson, substrings) {
  const scripts = pkgJson.scripts || {};
  const values = Object.values(scripts)
    .filter((s) => typeof s === 'string')
    .map((s) => s.toLowerCase());
  return substrings.some((sub) => values.some((s) => s.includes(sub)));
}

// Apenas Jest e Testing Library contam como testes de front-end
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
  return { hasFrontendTests, libs, hasJest, hasRTL };
}

async function detectTech(owner, repo) {
  let hasTS = false;
  let hasReact = false;
  let hasJest = false;
  let hasFrontendTests = false;
  let feLibs = [];
  let topics = [];

  // Linguagens
  const langs = await getRepoLanguages(owner, repo).catch(() => ({}));
  if (langs && typeof langs.TypeScript === 'number' && langs.TypeScript > 0) {
    hasTS = true;
  }

  // package.json
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
    hasJest = fe.hasJest; // provisório; pode ser confirmado por jest.config.*
  }

  // Topics ajudam a confirmar React
  topics = await getRepoTopics(owner, repo).catch(() => []);
  if (!hasReact) {
    if (topics.map((t) => t.toLowerCase()).includes('react')) hasReact = true;
  }

  // tsconfig.* confirma TS em alguns casos
  if (!hasTS) {
    const tsconfig = await getRepoContent(owner, repo, 'tsconfig.json');
    const tsconfigBase = tsconfig
      ? null
      : await getRepoContent(owner, repo, 'tsconfig.base.json');
    if (tsconfig || tsconfigBase) hasTS = true;
  }

  // Jest config na raiz (ajuda a marcar Jest)
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

  // Se detectou Jest por config, também conta como front-end tests (regra atual)
  if (!hasFrontendTests && hasJest) {
    hasFrontendTests = true;
  }

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

// Inclui "template"/"templates" além de boilerplate/starter/seed...
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
// Busca GraphQL
// =========================
const SEARCH_REPOS = `
query($queryString: String!, $first: Int!, $after: String) {
  search(query: $queryString, type: REPOSITORY, first: $first, after: $after) {
    repositoryCount
    edges {
      node {
        ... on Repository {
          name
          description
          owner { login }
          stargazerCount
        }
      }
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
`;

// =========================
// Sharding por trimestres (pushed)
// =========================

// “Bases” da query (termos principais)
const BASES = [
  'language:TypeScript react jest',
  'language:TypeScript "react" "jest" in:name,description,readme',
  'language:TypeScript topic:react jest',
  'language:TypeScript react in:name,description,readme',
  'language:TypeScript jest in:name,description,readme',
];

// Exclusões (boilerplate, starter, seed, template etc.) e filtros auxiliares
const EXCLUDE_TERMS =
  '-boilerplate -starter -seed -tutorial -course -bootcamp -template -templates';
const EXCLUDE_TOPICS =
  '-topic:boilerplate -topic:starter -topic:seed -topic:tutorial -topic:course -topic:template -topic:templates';

// Gera os últimos N trimestres (inclusive o trimestre corrente)
function buildLastNQuarters(n) {
  const ranges = [];
  const now = new Date();
  // início do trimestre atual (meses 0,3,6,9)
  const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
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
    // volta um trimestre
    cur = new Date(Date.UTC(y, m0 - 3, 1));
  }
  return ranges; // em ordem decrescente (Q_atual, Q-1, ..., Q-(n-1))
}

function buildQueries() {
  const quarters = buildLastNQuarters(QUARTERS_COUNT);
  console.log(
    `Shard por pushed (trimestres): ${quarters.length} trimestres (últimos ${QUARTERS_COUNT})`
  );
  const queries = [];
  for (const base of BASES) {
    for (const pushed of quarters) {
      queries.push(
        `${base} ${pushed} fork:false archived:false ${EXCLUDE_TOPICS} ${EXCLUDE_TERMS} sort:updated-desc`
      );
    }
  }
  return queries;
}

const QUERY_STRINGS = buildQueries();

// =========================
// Main
// =========================
async function main() {
  writeCsvHeaderIfNeeded();

  const processed = new Set();
  let totalQualified = 0;
  let reachedLimit = false;

  console.log(
    `Limites: MAX_QUALIFIED=${MAX_QUALIFIED} | MAX_ANALYZED=${MAX_ANALYZED}`
  );
  console.log(
    `Filtros: REQUIRE_FRONTEND_TESTS=${REQUIRE_FRONTEND_TESTS} | EXCLUDE_COURSE_BOILERPLATE(templates)=${EXCLUDE_COURSE_BOILERPLATE} | README_COURSE_CHECK=${README_COURSE_CHECK}`
  );
  console.log(`Queries geradas: ${QUERY_STRINGS.length}`);

  for (const queryString of QUERY_STRINGS) {
    if (reachedLimit || stopRequested) break;

    console.log(`\n🔎 Iniciando query: "${queryString}"`);
    let after = null;

    while (!reachedLimit && !stopRequested) {
      const vars = { queryString, first: BATCH_SIZE, after };

      let data;
      try {
        data = await ghGraphQL(SEARCH_REPOS, vars);
      } catch (err) {
        console.error(`❌ Erro GraphQL: ${err.message}`);
        break;
      }

      const edges = data?.search?.edges || [];
      if (edges.length === 0) {
        console.log('📄 Sem mais resultados nesta página.');
        break;
      }

      console.log(
        `📈 Disponíveis (aprox.): ${data.search.repositoryCount} | Página com ${edges.length} itens`
      );

      for (const edge of edges) {
        if (reachedLimit || stopRequested) break;

        const repo = edge.node;
        const nameWithOwner = `${repo.owner.login}/${repo.name}`;

        if (processed.has(nameWithOwner)) continue;
        processed.add(nameWithOwner);

        if (MAX_ANALYZED > 0 && processed.size > MAX_ANALYZED) {
          console.log(`Atingiu MAX_ANALYZED=${MAX_ANALYZED}. Finalizando...`);
          reachedLimit = true;
          break;
        }

        console.log(
          `🔍 Analisando: ${nameWithOwner} (${repo.stargazerCount}⭐)`
        );

        try {
          const tech = await detectTech(repo.owner.login, repo.name);
          const courseFlag = await detectCourseOrBoilerplate(
            repo.owner.login,
            repo.name,
            repo.name,
            repo.description,
            tech.topics
          );

          // Aplica filtros
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

          // Mantém se passou
          appendCsvRow({
            nameWithOwner,
            stars: repo.stargazerCount,
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

      if (!data.search.pageInfo.hasNextPage) {
        console.log('🏁 Fim da paginação para esta query.');
        break;
      }
      after = data.search.pageInfo.endCursor;

      await sleep(SLEEP_BETWEEN_PAGES_MS);
    }

    console.log(`📊 Query finalizada: "${queryString}"`);
    await sleep(1500);
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
