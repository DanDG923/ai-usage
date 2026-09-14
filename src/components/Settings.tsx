import { ChevronDown, Database, ShieldCheck, SlidersHorizontal, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { ManualObservation, PriceRow, Settings as SettingsType, Snapshot, UpdateStatus } from '../types';
import { AlertsSection } from './settings/AlertsSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { DiagnosticsSection } from './settings/DiagnosticsSection';
import { ForecastSection } from './settings/ForecastSection';
import { ManualSection } from './settings/ManualSection';
import { PricingSection } from './settings/PricingSection';
import { SourcesSection } from './settings/SourcesSection';
import { SubscriptionsSection } from './settings/SubscriptionsSection';
import { StorageSection } from './settings/StorageSection';

export type SettingsActions = {
  dataOperation: 'backup' | 'restore' | 'export' | null;
  onSetupClaude: () => void;
  onSettings: (patch: Partial<SettingsType>) => Promise<void | boolean>;
  onPrice: (row: PriceRow) => Promise<void>;
  onInstallClaude: () => Promise<void>;
  onUninstallClaude: () => Promise<void>;
  onBackup: () => Promise<void>;
  onRestore: () => Promise<void>;
  onOpenBackups: () => Promise<void>;
  onManual: (observation: ManualObservation) => Promise<boolean>;
  onExportCsv: (days: number) => Promise<void>;
  onCopySummary: () => Promise<void>;
  onSnooze: (hours: number) => Promise<void>;
  onCheckUpdates: () => Promise<UpdateStatus | null>;
};

export function Settings({ snapshot, actions }: { snapshot: Snapshot; actions: SettingsActions }) {
  const [saving, setSaving] = useState(false);
  const update = async (patch: Partial<SettingsType>) => {
    setSaving(true);
    try {
      return await actions.onSettings(patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main
      className="page settings-page"
      id="panel-settings"
      role="tabpanel"
      aria-labelledby="tab-settings"
      tabIndex={-1}
    >
      <section className="page-lead product-lead settings-lead">
        <div>
          <h1>Settings</h1>
          <p>
            Common preferences stay visible. Pricing, data-management, and diagnostic controls are available when
            needed.
          </p>
        </div>
        <div className="page-fact safe">
          <ShieldCheck aria-hidden="true" />
          <span>Everything stays on this PC</span>
        </div>
      </section>

      <div className="settings-content">
        <section className="settings-group" aria-labelledby="data-collection-heading">
          <div className="settings-group-heading">
            <Database aria-hidden="true" />
            <div>
              <h2 id="data-collection-heading">Data and collection</h2>
              <p>Choose which local sources contribute to your allowance view.</p>
            </div>
          </div>
          <SubscriptionsSection snapshot={snapshot} update={update} />
          <SourcesSection
            onSetupClaude={actions.onSetupClaude}
            snapshot={snapshot}
            update={update}
            onInstallClaude={actions.onInstallClaude}
            onUninstallClaude={actions.onUninstallClaude}
          />
        </section>

        <section className="settings-group" aria-labelledby="forecast-alerts-heading">
          <div className="settings-group-heading">
            <SlidersHorizontal aria-hidden="true" />
            <div>
              <h2 id="forecast-alerts-heading">Forecast and alerts</h2>
              <p>Set your normal schedule, reserve, and notification preferences.</p>
            </div>
          </div>
          <ForecastSection snapshot={snapshot} update={update} />
          <AlertsSection snapshot={snapshot} update={update} onSnooze={actions.onSnooze} />
        </section>

        <section className="settings-group" aria-labelledby="appearance-heading">
          <div className="settings-group-heading">
            <SlidersHorizontal aria-hidden="true" />
            <div>
              <h2 id="appearance-heading">Appearance and updates</h2>
              <p>Match Windows or choose a fixed theme, and control application updates.</p>
            </div>
          </div>
          <AppearanceSection snapshot={snapshot} update={update} onCheckUpdates={actions.onCheckUpdates} />
        </section>

        <details className="settings-disclosure">
          <summary>
            <span>
              <Database aria-hidden="true" />
              <span>
                <strong>Pricing and data management</strong>
                <small>API catalogue, backups, exports, and storage</small>
              </span>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          <div className="settings-disclosure-body">
            <PricingSection snapshot={snapshot} update={update} onPrice={actions.onPrice} />
            <StorageSection
              dataOperation={actions.dataOperation}
              snapshot={snapshot}
              update={update}
              onBackup={actions.onBackup}
              onRestore={actions.onRestore}
              onOpenBackups={actions.onOpenBackups}
              onExportCsv={actions.onExportCsv}
              onCopySummary={actions.onCopySummary}
            />
          </div>
        </details>

        <details className="settings-disclosure advanced-disclosure">
          <summary>
            <span>
              <Wrench aria-hidden="true" />
              <span>
                <strong>Advanced</strong>
                <small>Manual observations and diagnostics</small>
              </span>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          <div className="settings-disclosure-body">
            <ManualSection onManual={actions.onManual} />
            <DiagnosticsSection snapshot={snapshot} />
          </div>
        </details>

        {saving && (
          <span className="saving-toast" role="status">
            Saving locally…
          </span>
        )}
      </div>
    </main>
  );
}
