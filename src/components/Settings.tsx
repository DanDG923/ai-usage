import {
  BellRing,
  CircleDollarSign,
  Clock3,
  Download,
  HardDrive,
  Palette,
  PlugZap,
  ShieldCheck,
  Stethoscope,
} from 'lucide-react';
import { useState } from 'react';
import type { ManualObservation, PriceRow, Settings as SettingsType, Snapshot, UpdateStatus } from '../types';
import { AlertsSection } from './settings/AlertsSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { DiagnosticsSection } from './settings/DiagnosticsSection';
import { ForecastSection } from './settings/ForecastSection';
import { ManualSection } from './settings/ManualSection';
import { PricingSection } from './settings/PricingSection';
import { SourcesSection } from './settings/SourcesSection';
import { StorageSection } from './settings/StorageSection';

export type SettingsActions = {
  onSettings: (patch: Partial<SettingsType>) => Promise<void>;
  onPrice: (row: PriceRow) => Promise<void>;
  onInstallClaude: () => Promise<void>;
  onUninstallClaude: () => Promise<void>;
  onBackup: () => Promise<void>;
  onRestore: () => Promise<void>;
  onOpenBackups: () => Promise<void>;
  onManual: (observation: ManualObservation) => Promise<void>;
  onExportCsv: (days: number) => Promise<void>;
  onCopySummary: () => Promise<void>;
  onSnooze: (hours: number) => Promise<void>;
  onCheckUpdates: () => Promise<UpdateStatus | null>;
};

const NAV = [
  ['sources', PlugZap, 'Sources'],
  ['schedule', Clock3, 'Learned forecast'],
  ['alerts', BellRing, 'Alerts'],
  ['appearance', Palette, 'Appearance & updates'],
  ['pricing', CircleDollarSign, 'API pricing'],
  ['storage', HardDrive, 'Storage & export'],
  ['manual', Download, 'Manual observation'],
  ['diagnostics', Stethoscope, 'Diagnostics'],
] as const;

export function Settings({ snapshot, actions }: { snapshot: Snapshot; actions: SettingsActions }) {
  const [saving, setSaving] = useState(false);
  const update = async (patch: Partial<SettingsType>) => {
    setSaving(true);
    try {
      await actions.onSettings(patch);
    } finally {
      setSaving(false);
    }
  };
  return (
    <main className="page settings-page" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings">
      <aside className="settings-nav">
        <span className="eyebrow">Data &amp; settings</span>
        <h1>Local control room</h1>
        <p>Nothing is sent to a remote dashboard.</p>
        {NAV.map(([id, Icon, label]) => (
          <a key={id} href={`#${id}`}>
            <Icon aria-hidden="true" />
            {label}
          </a>
        ))}
        <div className="privacy-seal">
          <ShieldCheck aria-hidden="true" />
          <strong>Local-first</strong>
          <span>SQLite database and export files stay on this PC.</span>
        </div>
      </aside>
      <div className="settings-content">
        <SourcesSection
          snapshot={snapshot}
          update={update}
          onInstallClaude={actions.onInstallClaude}
          onUninstallClaude={actions.onUninstallClaude}
        />
        <ForecastSection snapshot={snapshot} update={update} />
        <AlertsSection snapshot={snapshot} update={update} onSnooze={actions.onSnooze} />
        <AppearanceSection snapshot={snapshot} update={update} onCheckUpdates={actions.onCheckUpdates} />
        <PricingSection snapshot={snapshot} update={update} onPrice={actions.onPrice} />
        <StorageSection
          snapshot={snapshot}
          update={update}
          onBackup={actions.onBackup}
          onRestore={actions.onRestore}
          onOpenBackups={actions.onOpenBackups}
          onExportCsv={actions.onExportCsv}
          onCopySummary={actions.onCopySummary}
        />
        <ManualSection onManual={actions.onManual} />
        <DiagnosticsSection snapshot={snapshot} />
        {saving && (
          <span className="saving-toast" role="status">
            Saving locally…
          </span>
        )}
      </div>
    </main>
  );
}
