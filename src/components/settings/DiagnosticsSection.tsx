import { formatInt, shortDate } from '../../lib';
import type { Snapshot, Source } from '../../types';
import { SettingBlock, SettingNote, SettingsSection } from './fields';
import { sourceMark } from './SourcesSection';

type Fact = { label: string; value: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, fallback = '—') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return Number.isFinite(value) ? formatInt(value) : fallback;
  return String(value);
}

function milliseconds(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? `${formatInt(value)} ms` : '—';
}

function sourceFacts(source: Source): Fact[] {
  const metadata = source.metadata || {};
  const facts: Fact[] = [
    { label: 'Status', value: `${source.status.replaceAll('-', ' ')}` },
    { label: 'Last scan', value: shortDate(source.last_attempt_at) },
    { label: 'Last good scan', value: shortDate(source.last_success_at) },
    { label: 'Newest evidence', value: shortDate(source.last_observation_at) },
  ];
  if (source.id === 'codex') {
    const appServer = record(metadata.appServer);
    const local = record(metadata.local);
    facts.push(
      { label: 'Executable', value: text(metadata.binary, 'not found') },
      {
        label: 'App server',
        value: appServer
          ? `${text(appServer.observations)} allowance windows · ${text(appServer.dailyBuckets)} daily totals${appServer.usageWarning ? ` · ${text(appServer.usageWarning)}` : ''}`
          : 'not reached',
      },
      {
        label: 'Session logs',
        value: local
          ? `${text(local.importedFiles)} files scanned · ${text(local.events)} token records · ${text(local.observations)} allowance rows${Number(local.rejected) > 0 ? ` · ${text(local.rejected)} rejected (${text(local.lastRejection)})` : ''}`
          : '—',
      },
      { label: 'Local warning', value: text(metadata.localWarning, 'none') },
    );
  }
  if (source.id === 'claude') {
    const provider = record(metadata.provider);
    const transcripts = record(metadata.transcripts);
    const statusLine = record(metadata.statusLine);
    facts.push(
      { label: 'Executable', value: text(metadata.binary, 'not found') },
      {
        label: 'SDK usage read',
        value: provider
          ? `${text(provider.kind)} · ${provider.attemptSucceeded ? 'responded' : 'failed'} in ${milliseconds(provider.durationMs)}${provider.errorCode ? ` · ${text(provider.errorCode)}` : ''} · ${text(provider.overallWindowsRecorded, '0')} windows recorded`
          : 'not attempted',
      },
      {
        label: 'Transcripts',
        value: transcripts
          ? `${text(transcripts.filesFound)} files found · ${text(transcripts.importedFiles)} changed · ${text(transcripts.usageEvents)} messages · ${text(transcripts.fableEvents)} Fable${Number(transcripts.rejectedRows) > 0 ? ` · ${text(transcripts.rejectedRows)} rejected (${text(transcripts.lastRejection)})` : ''}${Number(transcripts.readErrors) > 0 ? ` · ${text(transcripts.readErrors)} read errors (${text(transcripts.lastReadError)})` : ''}`
          : '—',
      },
      {
        label: 'Status-line inbox',
        value: statusLine
          ? `${text(statusLine.snapshots)} snapshots · ${text(statusLine.observations)} readings · ${text(statusLine.invalidRecords)} invalid · ${text(statusLine.rejectedRecords)} rejected · ${text(statusLine.readErrors)} read errors`
          : '—',
      },
      {
        label: 'Fallback helper',
        value: metadata.helperInstalled
          ? `installed${metadata.helperUpdated ? ' · updated this scan' : ''}`
          : 'not installed',
      },
    );
  }
  if (source.id === 'claude-fable') {
    const automatic = record(metadata.automatic);
    const health = record(automatic?.health);
    const allowance = record(automatic?.allowance);
    const derived = record(metadata.fableDerived);
    facts.push(
      {
        label: 'Allowance source',
        value: allowance
          ? `${text(allowance.kind)}${allowance.source ? ` · ${text(allowance.source)}` : ''}${allowance.reason ? ` · ${text(allowance.reason)}` : ''}`
          : '—',
      },
      {
        label: 'Health',
        value: health
          ? `${text(health.state)} · provider ${text(health.officialSource)} · activity ${text(health.activitySource)} in ${milliseconds(health.activityDurationMs)}`
          : '—',
      },
      {
        label: 'Local estimate',
        value: derived
          ? derived.derived
            ? `${text(derived.method)} · ${text(derived.usedPercent)}% used${derived.clamped ? ' · clamped' : ''}`
            : `not derived · ${text(derived.reason)}`
          : '—',
      },
      { label: 'Detail', value: text(health?.detail, 'none') },
    );
  }
  return facts;
}

export function DiagnosticsSection({ snapshot }: { snapshot: Snapshot }) {
  return (
    <SettingsSection
      id="diagnostics"
      title="Diagnostics"
      description="The raw outcome of the most recent collection, per source: latency, counters, and the reason for any fallback."
    >
      <SettingBlock className="diagnostics-grid">
        {snapshot.sources.map((source) => (
          <article key={source.id} className="diagnostics-card">
            <header>
              <span className={`source-mark ${source.id}`} aria-hidden="true">
                {sourceMark(source.id)}
              </span>
              <strong>{source.name}</strong>
            </header>
            <dl>
              {sourceFacts(source).map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </SettingBlock>
      <SettingNote>
        Snapshot generated {shortDate(snapshot.generatedAt)} · {snapshot.timezone} · database{' '}
        {(snapshot.storage.databaseSize / 1_048_576).toFixed(1)} MB
      </SettingNote>
    </SettingsSection>
  );
}
