import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  envSchema,
  loadEffectiveConfig,
  ConfigError,
  redactedConfigReport,
  formatConfigReport,
  initConfig,
  appConfig,
  PROJECT_ENV_PREFIXES,
  PROJECT_ENV_EXACT,
} from './env.js';

function minimalSource(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...overrides };
}

describe('CFG-1 · Config consolidation', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    // restore process.env
    for (const k of Object.keys(process.env)) delete (process.env as any)[k];
    for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) (process.env as any)[k] = v;
    vi.restoreAllMocks();
  });

  it('valid minimal parse: empty source yields defaults identical to today fallbacks', () => {
    const { config, issues } = loadEffectiveConfig({});
    expect(config.PORT).toBe(12077);
    expect(config.CLIENT_ORIGIN).toBe('http://localhost:22077');
    expect(config.NODE_ENV).toBe('development');
    expect(config.CONFIG_STRICT).toBe(true);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(config.RATE_LIMIT_MAX).toBe(300);
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(config.SOCKET_MSG_RATE_CAPACITY).toBe(15);
    expect(config.SOCKET_MSG_RATE_REFILL).toBe(5);
    expect(config.MAX_PARALLEL_AGENTS).toBe(4);
    expect(config.DURABLE_EVENTS).toBe(false);
    expect(config.PROVIDER_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(config.PROVIDER_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(config.STREAM_BATCH_MS).toBe(50);
    expect(config.PIPELINE_PARALLEL).toBe(true);
    expect(config.ORPHAN_AFTER_MS).toBe(60_000);
    expect(config.PER_ITERATION_BUDGET).toBe(true);
    expect(config.MEM_NOTE_CAP).toBe(500);
    expect(config.RETENTION_DAYS).toBe(30);
    expect(config.BUDGET_RECONCILE_MS).toBe(86_400_000);
    expect(config.TOOL_RWP).toBe(true);
    expect(config.MODEL_ROUTE).toBe('routed');
    expect(config.DELTA_INDEX).toBe(true);
    expect(config.QUEUE_MODE).toBe('inline');
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.REDIS_URL).toBeUndefined();
    expect(issues.unknownProjectVars).toHaveLength(0);
  });

  it('reserved Phase-5 flags default to safe off values', () => {
    const { config } = loadEffectiveConfig({});
    expect(config.APPROVALS_ENABLED).toBe(false);
    expect(config.SWARM_V1).toBe(false);
    expect(config.DEMO_FALLBACK).toBe(false);
    expect(config.LEGACY_GUARD).toBe(false);
    expect(config.LEGACY_BOOTSTRAP).toBe(false);
    expect(config.ENABLE_DB_CONFIG_MUTATION).toBe(false);
    expect(config.RUNS_ENABLED).toBe(true);
    expect(config.METRICS_ENABLED).toBe(true);
  });

  it('malformed known var blocks boot with ConfigError naming var+expected+received', () => {
    // int malformed
    expect(() => loadEffectiveConfig({ PORT: 'not-a-number' })).toThrow(ConfigError);
    try {
      loadEffectiveConfig({ PORT: 'not-a-number' });
    } catch (e) {
      expect((e as Error).message).toMatch(/PORT/);
      expect((e as Error).message).toMatch(/received/);
      expect((e as Error).message).toMatch(/not-a-number/);
      expect((e as ConfigError).name).toBe('ConfigError');
    }

    // bool malformed
    expect(() => loadEffectiveConfig({ RATE_LIMIT_ENABLED: 'maybe' })).toThrow(ConfigError);
    try {
      loadEffectiveConfig({ RATE_LIMIT_ENABLED: 'maybe' });
    } catch (e) {
      expect((e as Error).message).toMatch(/RATE_LIMIT_ENABLED/);
      expect((e as Error).message).toMatch(/maybe/);
    }

    // enum malformed
    expect(() => loadEffectiveConfig({ QUEUE_MODE: 'badmode' })).toThrow(ConfigError);
    try {
      loadEffectiveConfig({ QUEUE_MODE: 'badmode' });
    } catch (e) {
      expect((e as Error).message).toMatch(/QUEUE_MODE/);
    }

    // url malformed
    expect(() => loadEffectiveConfig({ DATABASE_URL: 'not-a-url' })).toThrow(ConfigError);
    try {
      loadEffectiveConfig({ DATABASE_URL: 'not-a-url' });
    } catch (e) {
      expect((e as Error).message).toMatch(/DATABASE_URL/);
    }

    // int bounds
    expect(() => loadEffectiveConfig({ PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadEffectiveConfig({ MAX_PARALLEL_AGENTS: '0' })).toThrow(ConfigError);
    expect(() => loadEffectiveConfig({ MEM_RETRIEVAL_WINDOW: '0' })).toThrow(ConfigError);
  });

  it('unknown project-prefixed var blocks strict (default) with named fix hint', () => {
    expect(() => loadEffectiveConfig({ AUTH_TYPO: '1' })).toThrow(ConfigError);
    try {
      loadEffectiveConfig({ AUTH_TYPO: '1' });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/Unknown project-prefixed/);
      expect(msg).toMatch(/AUTH_TYPO/);
      expect(msg).toMatch(/CONFIG_STRICT=false/);
      expect((e as ConfigError).issues.unknownProjectVars).toContain('AUTH_TYPO');
    }

    expect(() => loadEffectiveConfig({ RATE_LIMIT_FOO: '123' })).toThrow(ConfigError);
    expect(() => loadEffectiveConfig({ SOCKET_FOO: 'bar' })).toThrow(ConfigError);
    expect(() => loadEffectiveConfig({ PROVIDER_FOO: '1' })).toThrow(ConfigError);
    expect(() => loadEffectiveConfig({ MEM_FOO: '1' })).toThrow(ConfigError);
    expect(() => loadEffectiveConfig({ TOOL_RWP_FOO: '1' })).toThrow(ConfigError);
    expect(() => loadEffectiveConfig({ PIPELINE_TYPO: '1' })).toThrow(ConfigError);
    expect(() => loadEffectiveConfig({ ORPHAN_TYPO: '1' })).toThrow(ConfigError);
    // PORT_TYPO does NOT match project namespace per spec's exact list (PORT is exact, not prefix),
    // so it is treated as OS junk and never flagged — this is intentional to avoid false positives
    expect(() => loadEffectiveConfig({ PORT_TYPO: '1' })).not.toThrow();
    expect(loadEffectiveConfig({ PORT_TYPO: '1' }).issues.unknownProjectVars).toHaveLength(0);
  });

  it('CONFIG_STRICT=false lenient rollback: unknown project vars become warnings, not blocks', () => {
    const { config, issues } = loadEffectiveConfig({ AUTH_TYPO: '1', CONFIG_STRICT: 'false' });
    expect(config).toBeDefined();
    expect(issues.unknownProjectVars).toContain('AUTH_TYPO');

    const { issues: issues2 } = loadEffectiveConfig({ RATE_LIMIT_FOO: '1', SOCKET_BAR: '2', CONFIG_STRICT: 'false' });
    expect(issues2.unknownProjectVars).toContain('RATE_LIMIT_FOO');
    expect(issues2.unknownProjectVars).toContain('SOCKET_BAR');

    // malformed known var still blocks even in lenient mode
    expect(() => loadEffectiveConfig({ PORT: 'nan', CONFIG_STRICT: 'false' })).toThrow(ConfigError);
  });

  it('OS junk never flagged: PATH, HOSTNAME, CI, random vars, provider keys', () => {
    const { issues } = loadEffectiveConfig({
      PATH: '/usr/bin',
      HOSTNAME: 'myhost',
      HOME: '/home/user',
      CI: 'true',
      RANDOM_JUNK: '1',
      FOO_BAR: 'baz',
      OPENAI_API_KEY: 'sk-...',
      ANTHROPIC_API_KEY: 'sk-ant-...',
      GEMINI_API_KEY: 'key',
      npm_config_foo: 'bar',
    });
    expect(issues.unknownProjectVars).toHaveLength(0);

    // also with strict false, still not flagged
    const { issues: issues2 } = loadEffectiveConfig({
      RANDOM_JUNK: '1',
      HOSTNAME: 'x',
      CONFIG_STRICT: 'false',
    });
    expect(issues2.unknownProjectVars).toHaveLength(0);
  });

  it('desktop shell flags never block strict boot; server CROWDOS_ typos still block', () => {
    // packages/desktop sets CROWDOS_DEV=1 and reads CROWDOS_DEVTOOLS; both ride
    // along via process.env into the embedded backend and must stay inert.
    const dev = loadEffectiveConfig({ CROWDOS_DEV: '1' });
    expect(dev.issues.unknownProjectVars).toHaveLength(0);
    const devtools = loadEffectiveConfig({ CROWDOS_DEVTOOLS: '1' });
    expect(devtools.issues.unknownProjectVars).toHaveLength(0);
    const both = loadEffectiveConfig({ CROWDOS_DEV: '1', CROWDOS_DEVTOOLS: '0' });
    expect(both.issues.unknownProjectVars).toHaveLength(0);
    // server-relevant CROWDOS_ misspellings must still fail fast in strict mode.
    expect(() => loadEffectiveConfig({ CROWDOS_WS_TYPO: '1' })).toThrow(ConfigError);
    expect(() => loadEffectiveConfig({ CROWDOS_DATA_DIRR: '/tmp/x' })).toThrow(ConfigError);
    try {
      loadEffectiveConfig({ CROWDOS_WS_TYPO: '1' });
    } catch (e) {
      expect((e as ConfigError).issues.unknownProjectVars).toContain('CROWDOS_WS_TYPO');
    }
  });

  it('secrets are masked in redacted report and URLs are origin-only', () => {
    const { config } = loadEffectiveConfig({
      CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
      WORKSPACE_ADMIN_TOKEN: 'admin-secret',
      DATABASE_URL: 'postgresql://postgres:s3cr3t@db.example.com:5432/mydb?sslmode=require',
      REDIS_URL: 'redis://:pass@redis.example.com:6379/0',
    });
    const report = redactedConfigReport(config);
    expect(report.CREDENTIALS_ENCRYPTION_KEY).toBe('[redacted]');
    expect(report.WORKSPACE_ADMIN_TOKEN).toBe('[redacted]');
    // url redaction: origin only, no path/query/credentials
    expect(report.DATABASE_URL).toBe('postgresql://db.example.com:5432');
    expect(report.REDIS_URL).toBe('redis://redis.example.com:6379');
    // non-secret stays visible
    expect(report.PORT).toBe(12077);
    expect(report.RATE_LIMIT_MAX).toBe(300);
  });

  it('formatConfigReport produces aligned key = value lines and secrets already masked', () => {
    const { config } = loadEffectiveConfig({ PORT: '4000', WORKSPACE_ADMIN_TOKEN: 'secret' });
    const report = redactedConfigReport(config);
    const formatted = formatConfigReport(report);
    expect(formatted).toContain('PORT');
    expect(formatted).toContain('4000');
    expect(formatted).toContain('[redacted]');
    // DATABASE_URL absent => null
    expect(formatted).toContain('DATABASE_URL');
    // check alignment: lines contain " = "
    for (const line of formatted.split('\n')) {
      expect(line).toMatch(/ = /);
    }
  });

  it('initConfig boot hook loads, validates, prints redacted report and returns {config, issues}', () => {
    // setup process.env for initConfig (reads real process.env)
    process.env.PORT = '3456';
    process.env.AUTH_TYPO = 'should-warn';
    process.env.CONFIG_STRICT = 'false';
    const logs: string[] = [];
    const warns: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...a: unknown[]) => logs.push(String(a[0]));
    console.warn = (...a: unknown[]) => warns.push(String(a[0]));
    try {
      const result = initConfig({ log: true });
      expect(result.config.PORT).toBe(3456);
      expect(result.issues.unknownProjectVars).toContain('AUTH_TYPO');
      const joinedLog = logs.join('\n');
      expect(joinedLog).toContain('effective configuration');
      expect(joinedLog).toContain('PORT');
      expect(joinedLog).not.toContain('should-warn'); // secret? not secret but unknown var value should be in warn, not log
      const joinedWarn = warns.join('\n');
      expect(joinedWarn).toMatch(/CONFIG_STRICT=false/);
      expect(joinedWarn).toMatch(/AUTH_TYPO/);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      delete process.env.PORT;
      delete process.env.AUTH_TYPO;
      delete process.env.CONFIG_STRICT;
    }
  });

  it('initConfig throws ConfigError on malformed known var and does not print report', () => {
    process.env.PORT = 'bogus-port';
    expect(() => initConfig({ log: false })).toThrow(ConfigError);
    try {
      initConfig({ log: false });
    } catch (e) {
      expect((e as Error).message).toMatch(/PORT/);
      expect((e as Error).message).toMatch(/bogus-port/);
    } finally {
      delete process.env.PORT;
    }
  });

  it('initConfig respects log:false and custom logger function', () => {
    const lines: string[] = [];
    const result = initConfig({ log: (line: string) => lines.push(line) });
    expect(result.config).toBeDefined();
    expect(lines.join('\n')).toContain('effective configuration');
  });

  it('typed proxy appConfig reads cached after initConfig', () => {
    initConfig({ log: false });
    expect(typeof (appConfig as any).PORT).toBe('number');
    expect((appConfig as any).PORT).toBeGreaterThan(0);
    // spread / ownKeys works
    expect(Object.keys(appConfig as any).length).toBeGreaterThan(30);
    expect((appConfig as any).UNKNOWN_VAR).toBeUndefined();
  });

  it('schema has describe() on every field for docs generation', () => {
    for (const [key, field] of Object.entries(envSchema.shape)) {
      expect((field as any).description, `missing describe() for ${key}`).toBeTruthy();
      expect(typeof (field as any).description).toBe('string');
      expect((field as any).description.length).toBeGreaterThan(10);
    }
  });

  it('coerced vars are reported in issues.coerced when normalized !== raw', () => {
    // whitespace trimming and case normalization
    const { issues } = loadEffectiveConfig({ PORT: ' 12077 ', RATE_LIMIT_ENABLED: ' True ' });
    // PORT normalized from ' 12077 ' to '12077' => coerced
    expect(issues.coerced.some(c => c.var === 'PORT')).toBe(true);
  });

  it('PROJECT_ENV_PREFIXES and PROJECT_ENV_EXACT cover spec namespace', () => {
    // ensure spec prefixes are present
    const requiredPrefixes = ['AUTH_', 'QUEUE_', 'REDIS_', 'SOCKET_', 'PROVIDER_', 'MEM_', 'RETENTION_', 'BUDGET_', 'RATE_LIMIT_', 'METRICS_', 'MAX_PARALLEL', 'STREAM_BATCH', 'TOOL_RWP', 'MODEL_ROUTE', 'DELTA_INDEX', 'PER_ITERATION', 'RUNS_ENABLED', 'DURABLE_EVENTS', 'DEMO_FALLBACK', 'SWARM_', 'APPROVALS_', 'LEGACY_', 'CREDENTIALS_'];
    for (const p of requiredPrefixes) {
      expect((PROJECT_ENV_PREFIXES as readonly string[]).includes(p), `missing prefix ${p}`).toBe(true);
    }
    const requiredExacts = ['DATABASE_URL', 'WORKSPACE_ADMIN_TOKEN', 'PORT', 'HOST', 'CORS_ORIGIN'];
    for (const e of requiredExacts) {
      expect((PROJECT_ENV_EXACT as readonly string[]).includes(e), `missing exact ${e}`).toBe(true);
    }
  });
});
