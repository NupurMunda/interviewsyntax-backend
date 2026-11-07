import type {
  Answer, AiItem, ApiCategory, CompanyDetail, CompanyRef, Counts, DataStore, DsaItem, Graph, HldItem, ListItem, PrepKind, Profile, ResourceDetail, Solution, Topic, Value,
} from './types';

export type Row = Record<string, unknown>;
export type Run = (sql: string, params: unknown[]) => Promise<Row[]>;

const VISIBLE = "s.display_mode IN ('full','link')";

const CATEGORIES: Record<Exclude<ApiCategory, 'behavioral'>, string[]> = {
  dsa: ['leetcode'],
  hld: ['hld', 'system-design'],
  ai: ['ai'],
};
const PREP_CATEGORY: Record<PrepKind, string> = { ai: 'ai', 'system-design': 'hld' };
const inList = (values: string[]) => values.map((v) => `'${v}'`).join(',');
const SERVED_CATEGORIES = inList(Object.values(CATEGORIES).flat());

const apiCategory = (db: string): ApiCategory =>
  (Object.entries(CATEGORIES).find(([, dbCats]) => dbCats.includes(db))?.[0] ?? 'ai') as ApiCategory;

// One row per company; the only place visibility is turned into counts.
export const STATS_SELECT = `
WITH vr AS (
  SELECT r.id, r.category FROM resources r JOIN sources s ON s.id = r.source_id
  WHERE ${VISIBLE} AND r.category IN (${SERVED_CATEGORIES})
)
SELECT c.id AS company_id,
  COUNT(DISTINCT CASE WHEN vr.category IN (${inList(CATEGORIES.dsa)}) THEN vr.id END) AS dsa,
  COUNT(DISTINCT CASE WHEN vr.category IN (${inList(CATEGORIES.hld)}) THEN vr.id END) AS hld,
  COUNT(DISTINCT CASE WHEN vr.category IN (${inList(CATEGORIES.ai)}) THEN vr.id END) AS ai,
  (SELECT COUNT(*) FROM company_values cv JOIN sources s ON s.id = cv.source_id WHERE cv.company_id = c.id AND ${VISIBLE}) AS behavioral,
  EXISTS (SELECT 1 FROM company_profiles cp JOIN sources s ON s.id = cp.source_id WHERE cp.company_id = c.id AND ${VISIBLE}) AS has_profile
FROM companies c
LEFT JOIN company_resources cr ON cr.company_id = c.id
LEFT JOIN vr ON vr.id = cr.resource_id
GROUP BY c.id`;

export const STATS_DDL = `CREATE TABLE company_stats (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  dsa INTEGER NOT NULL, hld INTEGER NOT NULL, ai INTEGER NOT NULL, behavioral INTEGER NOT NULL, has_profile INTEGER NOT NULL
)`;

// Pairs of companies that share a visible HLD question, a < b.
export const EDGES_SELECT = `
WITH hq AS (
  SELECT DISTINCT cr.company_id, cr.resource_id FROM company_resources cr
  JOIN resources r ON r.id = cr.resource_id JOIN sources s ON s.id = r.source_id
  WHERE ${VISIBLE} AND r.category IN (${inList(CATEGORIES.hld)})
)
SELECT a.company_id AS company_a, b.company_id AS company_b, COUNT(*) AS weight
FROM hq a JOIN hq b ON b.resource_id = a.resource_id AND a.company_id < b.company_id
GROUP BY a.company_id, b.company_id`;

export const EDGES_DDL = `CREATE TABLE company_edges (
  company_a INTEGER NOT NULL REFERENCES companies(id),
  company_b INTEGER NOT NULL REFERENCES companies(id),
  weight INTEGER NOT NULL,
  PRIMARY KEY (company_a, company_b)
)`;

// Visible sources behind each company's resources, profile and values, so a company page needs no scan.
export const SOURCES_SELECT = `
SELECT x.company_id, x.source_id FROM (
  SELECT cr.company_id, r.source_id FROM company_resources cr JOIN resources r ON r.id = cr.resource_id
  WHERE r.category IN (${SERVED_CATEGORIES})
  UNION SELECT company_id, source_id FROM company_profiles
  UNION SELECT company_id, source_id FROM company_values
) x JOIN sources s ON s.id = x.source_id WHERE ${VISIBLE}`;

export const SOURCES_DDL = `CREATE TABLE company_sources (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  PRIMARY KEY (company_id, source_id)
)`;

// Local copy of the exported tables, built from the same DDL so primary keys (and query plans) match D1.
const tempTable = (ddl: string, name: string, select: string) =>
  `${ddl.replace('CREATE TABLE', 'CREATE TEMP TABLE').replace(/ REFERENCES \w+\(\w+\)/g, '')}; INSERT INTO ${name} SELECT * FROM (${select});`;

export const DERIVED_TABLES_SQL = [
  tempTable(STATS_DDL, 'company_stats', STATS_SELECT),
  tempTable(EDGES_DDL, 'company_edges', EDGES_SELECT),
  tempTable(SOURCES_DDL, 'company_sources', SOURCES_SELECT),
].join('\n');

const COMPANY_COLUMNS = 'c.id, c.name, c.slug, st.dsa, st.hld, st.ai, st.behavioral';
const COMPANY_FROM = 'FROM companies c JOIN company_stats st ON st.company_id = c.id';
const COMPANY_SHOWN = '(st.dsa + st.hld + st.ai > 0 OR st.has_profile = 1)';

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v == null ? null : String(v));
const topics = (v: unknown): string[] => JSON.parse(String(v ?? '[]'));
const counts = (r: Row): Counts => ({ dsa: num(r.dsa), hld: num(r.hld), ai: num(r.ai), behavioral: num(r.behavioral) });

const publicUrl = (v: unknown) => (typeof v === 'string' && v !== '' && !v.startsWith('local:') ? v : null);
const publicRepoUrl = (v: unknown) => publicUrl(v) ?? 'unknown';

const listItem = (r: Row): ListItem => ({
  id: num(r.id), title: String(r.title), url: publicUrl(r.url), difficulty: str(r.difficulty), topics: topics(r.topics),
});
const solution = (r: Row): Solution => ({ title: String(r.title), url: String(r.url), confidence: String(r.confidence), source: String(r.source) });

export function createStore(run: Run): DataStore {
  const one = async (sql: string, params: unknown[] = []) => (await run(sql, params))[0];
  const total = async (sql: string, params: unknown[]) => num((await one(sql, params))?.n);

  const values = async (companyId: number): Promise<Value[]> =>
    (await run(
      `SELECT cv.name, cv.my_blurb AS blurb, cv.official_source_url FROM company_values cv JOIN sources s ON s.id = cv.source_id
       WHERE cv.company_id = ? AND ${VISIBLE} ORDER BY cv.id`, [companyId],
    )).map((r) => ({ name: String(r.name), blurb: str(r.blurb), official_source_url: str(r.official_source_url) }));

  const categoryPage = async (companyId: number, category: ApiCategory, limit: number, offset: number) => {
    const where = `FROM company_resources cr JOIN resources r ON r.id = cr.resource_id JOIN sources s ON s.id = r.source_id
      WHERE cr.company_id = ? AND r.category IN (${inList(CATEGORIES[category as keyof typeof CATEGORIES])}) AND ${VISIBLE}`;
    const rows = await run(
      `SELECT r.id, r.title, r.url, r.level AS difficulty, r.topics ${where} GROUP BY r.id ORDER BY r.id LIMIT ? OFFSET ?`,
      [companyId, limit, offset],
    );
    return { items: rows.map(listItem), total: await total(`SELECT COUNT(DISTINCT r.id) AS n ${where}`, [companyId]) };
  };

  return {
    async listCompanies(q, { limit, offset }) {
      const where = `${COMPANY_SHOWN} AND (? IS NULL OR instr(lower(c.name), lower(?)) > 0)`;
      const params = [q ?? null, q ?? null];
      const rows = await run(`SELECT ${COMPANY_COLUMNS} ${COMPANY_FROM} WHERE ${where} ORDER BY c.name LIMIT ? OFFSET ?`, [...params, limit, offset]);
      return {
        items: rows.map((r) => ({ name: String(r.name), slug: String(r.slug), counts: counts(r) })),
        total: await total(`SELECT COUNT(*) AS n ${COMPANY_FROM} WHERE ${where}`, params),
      };
    },

    async findCompany(slug) {
      const r = await one(`SELECT ${COMPANY_COLUMNS} ${COMPANY_FROM} WHERE c.slug = ? AND ${COMPANY_SHOWN}`, [slug]);
      return r ? { id: num(r.id), name: String(r.name), slug: String(r.slug), counts: counts(r) } : null;
    },

    async getCompany(company: CompanyRef): Promise<CompanyDetail> {
      const p = await one(
        `SELECT cp.summary, cp.rounds_json, cp.source_urls, cp.confidence, cp.level, cp.notes, cp.last_reviewed
         FROM company_profiles cp JOIN sources s ON s.id = cp.source_id WHERE cp.company_id = ? AND ${VISIBLE}`, [company.id],
      );
      let profile: Profile | null = null;
      if (p) {
        const rounds = JSON.parse(String(p.rounds_json));
        profile = {
          summary: String(p.summary), rounds: rounds.rounds ?? [], other_steps: rounds.other_steps ?? [],
          confidence: p.confidence as Profile['confidence'], level: str(p.level), notes: str(p.notes),
          source_urls: JSON.parse(String(p.source_urls)), last_reviewed: String(p.last_reviewed),
        };
      }
      const sources = await run(
        `SELECT s.name, s.repo_url, s.license FROM company_sources cs JOIN sources s ON s.id = cs.source_id
         WHERE cs.company_id = ? ORDER BY s.id`, [company.id],
      );
      return {
        name: company.name, slug: company.slug, profile, categories: company.counts, values: await values(company.id),
        sources: sources.map((s) => ({ name: String(s.name), repo_url: publicRepoUrl(s.repo_url), license: String(s.license) })),
      };
    },

    async listDsa(companyId, { timeWindow, difficulty, topic, limit, offset }) {
      const where = `FROM company_resources cr JOIN resources r ON r.id = cr.resource_id JOIN sources s ON s.id = r.source_id
        WHERE cr.company_id = ? AND cr."window" = ? AND r.category IN (${inList(CATEGORIES.dsa)}) AND ${VISIBLE}
          AND (? IS NULL OR r.level = ?)
          AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(r.topics) j WHERE j.value = ?))`;
      const params = [companyId, timeWindow, difficulty ?? null, difficulty ?? null, topic ?? null, topic ?? null];
      const rows = await run(
        `SELECT r.id, r.title, r.url, r.level AS difficulty, r.topics, cr.frequency ${where}
         ORDER BY cr.frequency DESC, r.id LIMIT ? OFFSET ?`, [...params, limit, offset],
      );
      return {
        items: rows.map((r): DsaItem => ({ ...listItem(r), difficulty: listItem(r).difficulty as DsaItem['difficulty'], frequency: r.frequency == null ? null : num(r.frequency) })),
        total: await total(`SELECT COUNT(*) AS n ${where}`, params),
      };
    },

    async listHld(companyId, { limit, offset }) {
      const page = await categoryPage(companyId, 'hld', limit, offset);
      const rows = await run(
        `SELECT qs.question_id, qs.title, qs.url, qs.confidence, s.name AS source FROM question_solutions qs JOIN sources s ON s.id = qs.source_id
         WHERE qs.approved = 1 AND ${VISIBLE}
           AND EXISTS (SELECT 1 FROM company_resources cr WHERE cr.company_id = ? AND cr.resource_id = qs.question_id)
         ORDER BY qs.id`, [companyId],
      );
      const byQuestion = new Map<number, Solution[]>();
      for (const r of rows) byQuestion.set(num(r.question_id), [...(byQuestion.get(num(r.question_id)) ?? []), solution(r)]);
      // Our own collected links and summary come first; the matcher's solutions stay as a fallback.
      const ids = page.items.map((i) => i.id);
      const linkRows = ids.length
        ? await run(
          `SELECT ql.resource_id, ql.label, ql.url FROM question_links ql JOIN sources s ON s.id = ql.source_id
           WHERE ql.resource_id IN (${ids.join(',')}) AND ${VISIBLE} ORDER BY ql.resource_id, ql.position`, [],
        )
        : [];
      const infoRows = ids.length
        ? await run(
          `SELECT qi.resource_id, qi.summary FROM question_info qi JOIN sources s ON s.id = qi.source_id
           WHERE qi.resource_id IN (${ids.join(',')}) AND ${VISIBLE}`, [],
        )
        : [];
      return {
        total: page.total,
        items: page.items.map((i): HldItem => ({
          ...i, url: null, solutions: byQuestion.get(i.id) ?? [],
          summary: str(infoRows.find((r) => num(r.resource_id) === i.id)?.summary),
          links: linkRows.filter((r) => num(r.resource_id) === i.id).map((r) => ({ label: String(r.label), url: String(r.url) })),
        })),
      };
    },

    async listAi(companyId, { limit, offset }) {
      const page = await categoryPage(companyId, 'ai', limit, offset);
      const ids = page.items.map((i) => i.id);
      const answered = new Set(
        ids.length
          ? (await run(
            `SELECT qa.resource_id FROM question_answers qa JOIN sources s ON s.id = qa.source_id
             WHERE qa.resource_id IN (${ids.join(',')}) AND ${VISIBLE}`, [],
          )).map((r) => num(r.resource_id))
          : [],
      );
      return { total: page.total, items: page.items.map((i): AiItem => ({ ...i, has_answer: answered.has(i.id) })) };
    },

    async getBehavioral(companyId) {
      const topicRows = await run(
        `SELECT bt.slug, bt.name, bt.question_types, bt.typical_round FROM behavioral_topics bt JOIN sources s ON s.id = bt.source_id
         WHERE ${VISIBLE} ORDER BY bt.rowid`, [],
      );
      const topics: Topic[] = topicRows.map((r) => ({
        slug: String(r.slug), name: String(r.name), question_types: str(r.question_types), typical_round: str(r.typical_round),
      }));
      return { values: await values(companyId), topics };
    },

    async listPrep(kind, topic, { limit, offset }) {
      const category = PREP_CATEGORY[kind];
      // AI prep lists the questions that have a written answer; system design lists every question with its collected links.
      const listAll = kind === 'system-design';
      const where = `FROM ${listAll ? '' : 'question_answers qa JOIN '}resources r ${listAll ? '' : 'ON r.id = qa.resource_id '}JOIN sources s ON s.id = r.source_id
        WHERE r.category = ? AND ${VISIBLE} AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(r.topics) j WHERE j.value = ?))`;
      const params = [category, topic ?? null, topic ?? null];
      const rows = await run(`SELECT r.id, r.title, r.topics, ${listAll ? 'NULL' : 'qa.written'} AS written ${where} ORDER BY ${listAll ? '' : 'qa.written DESC, '}r.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
      const ids = rows.map((r) => num(r.id));
      const linkRows = listAll && ids.length
        ? await run(
          `SELECT ql.resource_id, ql.label, ql.url FROM question_links ql JOIN sources s ON s.id = ql.source_id
           WHERE ql.resource_id IN (${ids.join(',')}) AND ${VISIBLE} ORDER BY ql.resource_id, ql.position`, [],
        )
        : [];
      const infoRows = listAll && ids.length
        ? await run(
          `SELECT qi.resource_id, qi.summary, qi.concepts_json FROM question_info qi JOIN sources s ON s.id = qi.source_id
           WHERE qi.resource_id IN (${ids.join(',')}) AND ${VISIBLE}`, [],
        )
        : [];
      const perTopic = await run(
        `SELECT j.value AS name, COUNT(*) AS total, COUNT(qa.resource_id) AS answered
         FROM resources r JOIN sources s ON s.id = r.source_id JOIN json_each(r.topics) j
         LEFT JOIN question_answers qa ON qa.resource_id = r.id
         WHERE r.category = ? AND ${VISIBLE} GROUP BY j.value ORDER BY total DESC, name`, [category],
      );
      return {
        items: rows.map((r) => ({
          id: num(r.id), title: String(r.title), topics: topics(r.topics), written: str(r.written),
          summary: str(infoRows.find((i) => num(i.resource_id) === num(r.id))?.summary),
          concepts: topics(infoRows.find((i) => num(i.resource_id) === num(r.id))?.concepts_json),
          links: linkRows.filter((l) => num(l.resource_id) === num(r.id)).map((l) => ({ label: String(l.label), url: String(l.url) })),
        })),
        total: await total(`SELECT COUNT(*) AS n ${where}`, params),
        questions: await total(`SELECT COUNT(*) AS n FROM resources r JOIN sources s ON s.id = r.source_id WHERE r.category = ? AND ${VISIBLE}`, [category]),
        topics: perTopic.map((r) => ({ name: String(r.name), answered: num(r.answered), total: num(r.total) })),
      };
    },

    async getResource(id) {
      const r = await one(
        `SELECT r.id, r.title, r.category, r.url, r.level AS difficulty, r.topics, s.name AS source, s.license,
                CASE WHEN s.display_mode = 'full' THEN r.content_md END AS content_md
         FROM resources r JOIN sources s ON s.id = r.source_id
         WHERE r.id = ? AND r.category IN (${SERVED_CATEGORIES}) AND ${VISIBLE}`, [id],
      );
      if (!r) return null;
      const companies = await run(
        `SELECT DISTINCT c.name, c.slug FROM company_resources cr JOIN companies c ON c.id = cr.company_id WHERE cr.resource_id = ? ORDER BY c.name`, [id],
      );
      const solutions = await run(
        `SELECT qs.title, qs.url, qs.confidence, s.name AS source FROM question_solutions qs JOIN sources s ON s.id = qs.source_id
         WHERE qs.question_id = ? AND qs.approved = 1 AND ${VISIBLE} ORDER BY qs.id`, [id],
      );
      const a = await one(
        `SELECT qa.answer_json, qa.written FROM question_answers qa JOIN sources s ON s.id = qa.source_id
         WHERE qa.resource_id = ? AND ${VISIBLE}`, [id],
      );
      const answer: Answer | null = a ? { ...JSON.parse(String(a.answer_json)), written: String(a.written) } : null;
      return {
        ...listItem(r), category: apiCategory(String(r.category)), answer, content_md: str(r.content_md),
        source: { name: String(r.source), license: String(r.license) },
        companies: companies.map((c) => ({ name: String(c.name), slug: String(c.slug) })),
        solutions: solutions.map(solution),
      } satisfies ResourceDetail;
    },

    async getGraph(limit): Promise<Graph> {
      const nodeRows = await run(
        `SELECT c.id, c.slug, c.name, st.dsa + st.hld + st.ai AS size ${COMPANY_FROM}
         WHERE st.dsa + st.hld + st.ai > 0 ORDER BY size DESC, c.name LIMIT ?`, [limit],
      );
      if (!nodeRows.length) return { nodes: [], edges: [] };
      const ids = nodeRows.map((r) => num(r.id)).join(',');
      const edgeRows = await run(
        `SELECT ca.slug AS a, cb.slug AS b, e.weight FROM company_edges e
         JOIN companies ca ON ca.id = e.company_a JOIN companies cb ON cb.id = e.company_b
         WHERE e.company_a IN (${ids}) AND e.company_b IN (${ids}) ORDER BY e.weight DESC, ca.slug, cb.slug`, [],
      );
      return {
        nodes: nodeRows.map((r) => ({ slug: String(r.slug), name: String(r.name), size: num(r.size) })),
        edges: edgeRows.map((r) => ({ a: String(r.a), b: String(r.b), weight: num(r.weight) })),
      };
    },

    async listSources() {
      const rows = await run(
        `SELECT s.name, s.repo_url, s.license, s.author, s.license_text, s.notice_text, s.adapted, s.adaptation_note
         FROM sources s WHERE ${VISIBLE} ORDER BY s.id`, [],
      );
      return rows.map((r) => ({
        name: String(r.name), repo_url: publicRepoUrl(r.repo_url), license: String(r.license), author: str(r.author),
        license_text: str(r.license_text), notice_text: str(r.notice_text), adapted: num(r.adapted) === 1, adaptation_note: str(r.adaptation_note),
      }));
    },
  };
}
