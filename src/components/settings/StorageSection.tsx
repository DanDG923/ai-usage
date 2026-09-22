import { ClipboardCopy, ExternalLink, FileSpreadsheet, RotateCcw, Save } from 'lucide-react';
import { useState } from 'react';
import type { Settings, Snapshot } from '../../types';
import { NumericSetting, SectionHeading } from './fields';

export function StorageSection({
  dataOperation,
  snapshot,
  update,
  onBackup,
  onRestore,
  onOpenBackups,
  onExportCsv,
  onCopySummary,
}: {
  dataOperation: 'backup' | 'restore' | 'export' | null;
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
  onBackup: () => Promise<void>;
  onRestore: () => Promise<void>;
  onOpenBackups: () => Promise<void>;
  onExportCsv: (days: number) => Promise<void>;
  onCopySummary: () => Promise<void>;
}) {
  const [exportDays, setExportDays] = useState(90);
  return (
    <section id="storage" className="panel settings-section">
      <SectionHeading
        title="Storage & export"
        description="Scheduled backups write both the database and a readable .aiusage.json export, with automatic retention."
      />
      <div className="settings-fields storage-fields">
        <label>
          <span>Backup schedule</span>
          <select
            value={snapshot.settings.backupFrequency}
            onChange={(event) => update({ backupFrequency: event.target.value })}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="off">Off</option>
          </select>
        </label>
        <NumericSetting
          label="Backup sets kept"
          value={snapshot.settings.backupRetentionCount}
          min={1}
          max={365}
          step={1}
          onCommit={(value) => update({ backupRetentionCount: Math.round(value) })}
        />
      </div>
      <div className="path-card">
        <span>Database</span>
        <code>{snapshot.storage.databasePath}</code>
        <small>{(snapshot.storage.databaseSize / 1_048_576).toFixed(1)} MB</small>
      </div>
      <div className="path-card">
        <span>Backups</span>
        <code>{snapshot.storage.backupDirectory}</code>
      </div>
      <div className="action-row">
        <button className="primary-button" disabled={Boolean(dataOperation)} onClick={onBackup}>
          <Save aria-hidden="true" />
          {dataOperation === 'backup' ? 'Backing up…' : 'Back up now'}
        </button>
        <button className="secondary-button" disabled={Boolean(dataOperation)} onClick={onRestore}>
          <RotateCcw aria-hidden="true" />
          {dataOperation === 'restore' ? 'Restoring…' : 'Restore from backup…'}
        </button>
        <button className="secondary-button" onClick={onOpenBackups}>
          <ExternalLink aria-hidden="true" />
          Open backup folder
        </button>
      </div>
      {dataOperation && (
        <p className="storage-operation" role="status">
          {dataOperation === 'backup'
            ? 'Creating the local backup…'
            : dataOperation === 'restore'
              ? 'Restoring the selected backup…'
              : 'Writing the CSV export…'}{' '}
          You can continue browsing while this finishes.
        </p>
      )}
      <p className="restore-note">
        Restoring merges a <code>.sqlite</code> backup or an <code>.aiusage.json</code> export into the local database;
        large histories restore from the <code>.sqlite</code> backup. Token records, observations, daily totals and
        prices already held are kept as they are, so nothing is counted twice or rolled back.{' '}
        <strong>Your settings are replaced by the ones in the export.</strong> A fresh backup is written first.
      </p>
      <div className="export-row">
        <div>
          <strong>Export</strong>
          <small>
            A CSV of the token ledger with the current-catalogue value per record, or a plain-text summary of every
            allowance for pasting into a message.
          </small>
        </div>
        <div className="action-row compact">
          <select
            disabled={dataOperation === 'export'}
            aria-label="Export period"
            value={exportDays}
            onChange={(event) => setExportDays(Number(event.target.value))}
          >
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
          <button
            className="secondary-button"
            disabled={Boolean(dataOperation)}
            onClick={() => onExportCsv(exportDays)}
          >
            <FileSpreadsheet aria-hidden="true" />
            {dataOperation === 'export' ? 'Exporting…' : 'Export CSV…'}
          </button>
          <button className="secondary-button" onClick={onCopySummary}>
            <ClipboardCopy aria-hidden="true" />
            Copy summary
          </button>
        </div>
      </div>
    </section>
  );
}
