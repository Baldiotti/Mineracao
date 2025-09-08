/* scripts/mine_ts_react_jest.js */
/* Node 18+ (fetch nativo). Execute: `node scripts/mine_ts_react_jest.js` */

'use strict';

const fs = require('fs');
const path = require('path');

// Implementação nativa de controle de concorrência (substitui p-limit)
class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        fn,
        resolve,
        reject,
      });
      this.tryNext();
    });
  }

  tryNext() {
    if (this.running >= this.limit || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { fn, resolve, reject } = this.queue.shift();

    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this.running--;
        this.tryNext();
      });
  }
}

const OUTPUT_DIR = 'output';
const CSV_FILE = path.join(OUTPUT_DIR, 'repos_ts_react_jest.csv');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10);
const SLEEP_BETWEEN_PAGES_MS = parseInt(
  process.env.SLEEP_BETWEEN_PAGES_MS || '800',
  10
);

const MAX_QUALIFIED = parseInt(process.env.MAX_QUALIFIED || '10000', 10);
const MAX_ANALYZED = parseInt(process.env.MAX_ANALYZED || '10000', 10);

const REQUIRE_FRONTEND_TESTS =
  (process.env.REQUIRE_FRONTEND_TESTS || 'true').toLowerCase() === 'true';
const EXCLUDE_COURSE_BOILERPLATE =
  (process.env.EXCLUDE_COURSE_BOILERPLATE || 'true').toLowerCase() === 'true';
const README_COURSE_CHECK =
  (process.env.README_COURSE_CHECK || 'false').toLowerCase() === 'true';

const EXCLUDE_TOPICS = (process.env.EXCLUDE_TOPICS || '').trim();

const QUARTERS_COUNT = parseInt(process.env.QUARTERS_COUNT || '20', 10);

// Concorrência
const CONCURRENT_REPOS = parseInt(process.env.CONCURRENT_REPOS || '5', 10);
const limiter = new ConcurrencyLimiter(CONCURRENT_REPOS);

// Token

const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || process.env.PAT || process.env.GH_TOKEN;

if (!GITHUB_TOKEN) {
  console.error('Erro: GITHUB_TOKEN não encontrado.');
  process.exit(1);
}

let stopRequested = false;
process.on('SIGTERM', () => {
  stopRequested = true;
});
process.on('SIGINT', () => {
  stopRequested = true;
});

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
      'Repositorio,Link,Estrelas,TypeScript,React,Jest,FrontendTestLibs,ReactDeps,TestLibsDetected\n',
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
  hasReactDeps,
  hasFrontendTestLibs,
}) {
  const libs = (feLibs || []).join('|');
  const link = `https://github.com/${nameWithOwner}`;
  const line = `${nameWithOwner},${link},${stars},${hasTS ? 'Sim' : 'Não'},${
    hasReact ? 'Sim' : 'Não'
  },${hasJest ? 'Sim' : 'Não'},${libs},${hasReactDeps ? 'Sim' : 'Não'},${
    hasFrontendTestLibs ? 'Sim' : 'Não'
  }\n`;
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

async function checkDynamicRateLimit(res) {
  const remaining = parseInt(
    res.headers.get('x-ratelimit-remaining') || '5000',
    10
  );
  const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10);

  if (remaining < 1000 && reset > 0) {
    const resetTime = reset * 1000;
    const now = Date.now();
    const timeToReset = Math.max(0, resetTime - now);

    // Calcula sleep proporcional baseado no remaining
    const proportionalWait = Math.min(
      timeToReset / Math.max(remaining, 1),
      5000
    );

    if (proportionalWait > 100) {
      // Só pausa se for significativo
      console.log(
        `⏳ Rate limit baixo (${remaining} restantes). Pausando ${(
          proportionalWait / 1000
        ).toFixed(1)}s...`
      );
      await sleep(proportionalWait);
    }
  }
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

    // Controle dinâmico de rate limit
    await checkDynamicRateLimit(res);

    return { status: res.status, data };
  }
}

async function ghGraphQL(query, variables = {}) {
  while (true) {
    const res = await fetchWithTimeout('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 403) {
      const retry = await handleRateLimit(res);
      if (retry) continue;
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(
        `GraphQL falhou: ${res.status} - ${res.statusText} - ${txt.slice(
          0,
          300
        )}`
      );
    }

    const data = await res.json().catch(() => null);

    // Controle dinâmico de rate limit
    await checkDynamicRateLimit(res);

    if (data?.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return data?.data || null;
  }
}

async function getRepoInfoGraphQL(owner, repo) {
  const query = `
    query GetRepoInfo($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        languages(first: 20) {
          edges {
            size
            node {
              name
            }
          }
        }
        repositoryTopics(first: 20) {
          nodes {
            topic {
              name
            }
          }
        }
        packageJson: object(expression: "HEAD:package.json") {
          ... on Blob {
            text
          }
        }
        tsconfig: object(expression: "HEAD:tsconfig.json") {
          ... on Blob {
            text
          }
        }
        tsconfigBase: object(expression: "HEAD:tsconfig.base.json") {
          ... on Blob {
            text
          }
        }
        jestConfigJs: object(expression: "HEAD:jest.config.js") {
          ... on Blob {
            text
          }
        }
        jestConfigCjs: object(expression: "HEAD:jest.config.cjs") {
          ... on Blob {
            text
          }
        }
        jestConfigMjs: object(expression: "HEAD:jest.config.mjs") {
          ... on Blob {
            text
          }
        }
        jestConfigTs: object(expression: "HEAD:jest.config.ts") {
          ... on Blob {
            text
          }
        }
        jestConfigJson: object(expression: "HEAD:jest.config.json") {
          ... on Blob {
            text
          }
        }
      }
    }
  `;

  try {
    const data = await ghGraphQL(query, { owner, name: repo });
    return data?.repository || null;
  } catch (err) {
    console.warn(`⚠️ GraphQL falhou para ${owner}/${repo}: ${err.message}`);
    return null;
  }
}

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

async function searchForTestFiles(owner, repo) {
  const testPatterns = ['src', '__tests__', 'test', 'tests'];

  let foundReactTests = false;

  for (const pattern of testPatterns) {
    if (foundReactTests) break;

    try {
      const { status, data } = await ghGET(
        `https://api.github.com/repos/${owner}/${repo}/contents/${pattern}`
      );

      if (status === 200 && Array.isArray(data)) {
        foundReactTests = await searchDirectoryForReactTests(
          owner,
          repo,
          data,
          pattern
        );
      }
    } catch (err) {
      continue;
    }
  }

  return foundReactTests;
}

async function searchDirectoryForReactTests(
  owner,
  repo,
  contents,
  basePath = ''
) {
  for (const item of contents) {
    if (item.type === 'file') {
      if (item.name.match(/\.(test|spec)\.tsx?$/)) {
        try {
          const content = await getRepoContent(owner, repo, item.path);
          if (content) {
            const hasRenderImport =
              content.includes('import { render }') &&
              content.includes('@testing-library/react');
            const hasEnzymeImport =
              content.includes('enzyme') ||
              content.includes('shallow') ||
              content.includes('mount');

            if (hasRenderImport || hasEnzymeImport) {
              console.log(`✅ Encontrado arquivo de teste React: ${item.path}`);
              return true;
            }
          }
        } catch (err) {
          continue;
        }
      }
    } else if (
      item.type === 'dir' &&
      item.name !== 'node_modules' &&
      item.name !== '.git'
    ) {
      const depth = basePath.split('/').length;
      if (depth < 3) {
        try {
          const { status, data } = await ghGET(
            `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`
          );

          if (status === 200 && Array.isArray(data)) {
            const found = await searchDirectoryForReactTests(
              owner,
              repo,
              data,
              item.path
            );
            if (found) return true;
          }
        } catch (err) {
          continue;
        }
      }
    }
  }

  return false;
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

function detectFrontendFromPkg(pkgJson) {
  const libs = [];

  const hasJest =
    pkgHasAnyDep(pkgJson, ['jest', '@jest/globals', 'ts-jest', 'babel-jest']) ||
    scriptsContain(pkgJson, ['jest']);

  const hasReactDeps = pkgHasAnyDep(pkgJson, ['react', 'react-dom']);

  const hasRTL = pkgHasAnyDep(pkgJson, [
    '@testing-library/react',
    '@testing-library/jest-dom',
    '@testing-library/user-event',
  ]);
  const hasEnzyme = pkgHasAnyDep(pkgJson, ['enzyme']);

  if (hasRTL) libs.push('testing-library');
  if (hasEnzyme) libs.push('enzyme');
  if (hasJest) libs.push('jest');

  const hasFrontendTestLibs = hasRTL || hasEnzyme;
  const hasFrontendTests = hasReactDeps && hasJest && hasFrontendTestLibs;

  return {
    hasFrontendTests,
    libs,
    hasJest,
    hasReactDeps,
    hasFrontendTestLibs,
  };
}

async function detectTech(owner, repo) {
  let hasTS = false;
  let hasReact = false;
  let hasJest = false;
  let hasFrontendTests = false;
  let feLibs = [];
  let topics = [];
  let hasReactDeps = false;
  let hasFrontendTestLibs = false;

  // Busca informações via GraphQL primeiro
  const repoInfo = await getRepoInfoGraphQL(owner, repo);

  if (repoInfo) {
    // Processa linguagens
    const languages = {};
    if (repoInfo.languages?.edges) {
      repoInfo.languages.edges.forEach((edge) => {
        languages[edge.node.name] = edge.size;
      });
    }

    if (languages.TypeScript && languages.TypeScript > 0) {
      hasTS = true;
    }

    // Processa tópicos
    if (repoInfo.repositoryTopics?.nodes) {
      topics = repoInfo.repositoryTopics.nodes.map((node) => node.topic.name);
    }

    // Processa package.json
    let pkgJson = null;
    if (repoInfo.packageJson?.text) {
      try {
        pkgJson = JSON.parse(repoInfo.packageJson.text);
      } catch (err) {
        console.warn(`⚠️ Erro ao parsear package.json de ${owner}/${repo}`);
      }
    }

    if (pkgJson) {
      hasReactDeps = pkgHasAnyDep(pkgJson, ['react', 'react-dom']);
      hasReact = hasReactDeps;

      if (!hasTS && pkgHasAnyDep(pkgJson, ['typescript'])) hasTS = true;

      const fe = detectFrontendFromPkg(pkgJson);
      hasFrontendTests = fe.hasFrontendTests;
      feLibs = fe.libs;
      hasJest = fe.hasJest;
      hasFrontendTestLibs = fe.hasFrontendTestLibs;

      console.log(
        `📦 Package.json - React: ${hasReactDeps}, Jest: ${hasJest}, Frontend Test Libs: ${hasFrontendTestLibs}`
      );
    }

    // Verifica React nos tópicos se não encontrou nas deps
    if (!hasReact && topics.map((t) => t.toLowerCase()).includes('react'))
      hasReact = true;

    // Verifica TypeScript nos arquivos de config
    if (!hasTS) {
      const hasTsConfig = !!(
        repoInfo.tsconfig?.text || repoInfo.tsconfigBase?.text
      );
      if (hasTsConfig) hasTS = true;
    }

    // Verifica Jest nos arquivos de config
    if (!hasJest) {
      const jestConfigs = [
        repoInfo.jestConfigJs?.text,
        repoInfo.jestConfigCjs?.text,
        repoInfo.jestConfigMjs?.text,
        repoInfo.jestConfigTs?.text,
        repoInfo.jestConfigJson?.text,
      ];

      const hasJestConfig = jestConfigs.some((config) => !!config);
      if (hasJestConfig) {
        hasJest = true;
        if (!feLibs.includes('jest')) feLibs.push('jest');
      }
    }
  } else {
    // Fallback para REST API se GraphQL falhar
    console.log(`🔄 Fallback para REST API: ${owner}/${repo}`);

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
      hasReactDeps = pkgHasAnyDep(pkgJson, ['react', 'react-dom']);
      hasReact = hasReactDeps;

      if (!hasTS && pkgHasAnyDep(pkgJson, ['typescript'])) hasTS = true;

      const fe = detectFrontendFromPkg(pkgJson);
      hasFrontendTests = fe.hasFrontendTests;
      feLibs = fe.libs;
      hasJest = fe.hasJest;
      hasFrontendTestLibs = fe.hasFrontendTestLibs;

      console.log(
        `📦 Package.json - React: ${hasReactDeps}, Jest: ${hasJest}, Frontend Test Libs: ${hasFrontendTestLibs}`
      );
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
  }

  // Se não encontrou libs de teste no package.json, busca por arquivos de teste
  if (hasReact && hasJest && !hasFrontendTestLibs) {
    console.log(`🔍 Buscando arquivos de teste React na estrutura...`);
    try {
      const foundTestFiles = await searchForTestFiles(owner, repo);
      if (foundTestFiles) {
        hasFrontendTestLibs = true;
        feLibs.push('test-files');
        console.log(`✅ Encontrados arquivos de teste React válidos`);
      }
    } catch (err) {
      console.log(`⚠️ Erro ao buscar arquivos de teste: ${err.message}`);
    }
  }

  // Regra final: só é válido se tiver React + Jest + evidência de testes de frontend
  hasFrontendTests = hasReact && hasJest && hasFrontendTestLibs;

  return {
    hasTS,
    hasReact,
    hasJest,
    hasFrontendTests,
    feLibs,
    topics,
    hasReactDeps,
    hasFrontendTestLibs,
  };
}

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

function buildLastNQuarters(n) {
  const ranges = [];
  const now = new Date();
  const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  let cur = new Date(Date.UTC(now.getUTCFullYear(), qStartMonth, 1));

  for (let i = 0; i < n; i++) {
    const y = cur.getUTCFullYear();
    const m0 = cur.getUTCMonth();
    const qEndMonth = m0 + 2;
    const lastDay = new Date(Date.UTC(y, qEndMonth + 1, 0)).getUTCDate();
    const start = `${y}-${String(m0 + 1).padStart(2, '0')}-01`;
    const finish = `${y}-${String(qEndMonth + 1).padStart(2, '0')}-${String(
      lastDay
    ).padStart(2, '0')}`;
    ranges.push(`pushed:${start}..${finish}`);
    cur = new Date(Date.UTC(y, m0 - 3, 1));
  }
  return ranges;
}

const BASES = [
  'language:TypeScript react',
  'language:TypeScript topic:react',
  'language:TypeScript "react" in:name,description,readme',
];

function buildQueries() {
  const quarters = buildLastNQuarters(QUARTERS_COUNT);
  const queries = [];
  const excl = EXCLUDE_TOPICS;
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

async function processRepository(item, processed) {
  const nameWithOwner = item.full_name;

  if (processed.has(nameWithOwner)) return null;
  processed.add(nameWithOwner);

  console.log(`🔍 Analisando: ${nameWithOwner} (${item.stargazers_count}⭐)`);

  try {
    const tech = await detectTech(item.owner.login, item.name);
    const courseFlag = await detectCourseOrBoilerplate(
      item.owner.login,
      item.name,
      item.name,
      item.description,
      tech.topics
    );

    if (EXCLUDE_COURSE_BOILERPLATE && courseFlag.isCourseOrBoilerplate) {
      console.log(
        `⏭️ Excluído por curso/boilerplate/template: ${nameWithOwner}`
      );
      return null;
    }

    if (!(tech.hasTS && tech.hasReact)) {
      console.log(
        `❌ Falta TS ou React (TS:${tech.hasTS} React:${tech.hasReact}): ${nameWithOwner}`
      );
      return null;
    }

    if (!tech.hasFrontendTests) {
      console.log(
        `❌ Não atende critérios de testes frontend (React:${tech.hasReact} Jest:${tech.hasJest} FrontendTestLibs:${tech.hasFrontendTestLibs}): ${nameWithOwner}`
      );
      return null;
    }

    const repoData = {
      nameWithOwner,
      stars: item.stargazers_count,
      hasTS: tech.hasTS,
      hasReact: tech.hasReact,
      hasJest: tech.hasJest,
      feLibs: tech.feLibs,
      hasReactDeps: tech.hasReactDeps,
      hasFrontendTestLibs: tech.hasFrontendTestLibs,
    };

    console.log(`✅ Validado: ${nameWithOwner}`);
    return repoData;
  } catch (err) {
    console.warn(`⚠️ Falha ao analisar ${nameWithOwner}: ${err.message}`);
    return null;
  }
}

async function main() {
  writeCsvHeaderIfNeeded();

  const processed = new Set();
  let totalQualified = 0;
  let reachedLimit = false;

  const queries = buildQueries();
  console.log(`Queries geradas: ${queries.length}`);
  console.log(
    `Concorrência configurada: ${CONCURRENT_REPOS} repositórios em paralelo`
  );
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

      // Processa repositórios em paralelo
      console.log(
        `🔄 Processando ${items.length} repositórios em paralelo (máx ${CONCURRENT_REPOS})...`
      );
      const tasks = items.map((item) =>
        limiter.add(() => processRepository(item, processed))
      );

      const results = await Promise.all(tasks);
      const validResults = results.filter((r) => r !== null);
      console.log(
        `📊 Lote processado: ${validResults.length}/${items.length} repositórios válidos`
      );

      // Escreve resultados válidos no CSV
      for (const result of validResults) {
        if (result && !reachedLimit && !stopRequested) {
          appendCsvRow(result);
          totalQualified++;
          console.log(
            `📝 Registrado: ${result.nameWithOwner} | Total qualificados: ${totalQualified}`
          );

          if (totalQualified >= MAX_QUALIFIED) {
            console.log(
              `Atingiu MAX_QUALIFIED=${MAX_QUALIFIED}. Finalizando...`
            );
            reachedLimit = true;
            break;
          }
        }
      }

      if (reachedLimit || stopRequested) break;

      // Verifica limite de repositórios analisados
      if (MAX_ANALYZED > 0 && processed.size >= MAX_ANALYZED) {
        console.log(`Atingiu MAX_ANALYZED=${MAX_ANALYZED}. Finalizando...`);
        reachedLimit = true;
        break;
      }

      if (reachedLimit || stopRequested) break;

      const maxPages = Math.ceil(
        Math.min(result.total_count, 1000) / BATCH_SIZE
      );
      if (page >= maxPages) {
        console.log('🏁 Fim da paginação desta query (limite da Search API).');
        break;
      }
      page += 1;
      // Sleep dinâmico já está sendo controlado em ghGET/ghGraphQL
    }

    console.log('📊 Query finalizada.');
    // Removido sleep fixo - controle dinâmico está ativo
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
