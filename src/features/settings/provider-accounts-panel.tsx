"use client";

import { Check, Eye, EyeOff, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { CustomSelect } from "@/components/custom-select";
import { apiErrorMessage, apiGet } from "@/lib/api-client";
import type { ProviderAccountProvider, ProviderAccountsResponse, ProviderAccountSummary } from "@/lib/api-contracts";
import { t, type Language } from "@/lib/i18n";
import type { MarketId } from "@/lib/types";
import { StatusBanner } from "../shared/feature-shell";

type ProviderAccountsPanelProps = {
  marketId: MarketId;
  language: Language;
};

type ProviderDraft = {
  enabled: boolean;
  secrets: Record<string, string>;
  config: Record<string, string>;
};

type ProviderDrafts = Partial<Record<ProviderAccountProvider, ProviderDraft>>;

export function ProviderAccountsPanel({ marketId, language }: ProviderAccountsPanelProps) {
  const [payload, setPayload] = useState<ProviderAccountsResponse | null>(null);
  const [drafts, setDrafts] = useState<ProviderDrafts>({});
  const [visibleSecrets, setVisibleSecrets] = useState<Partial<Record<ProviderAccountProvider, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [savingProvider, setSavingProvider] = useState<ProviderAccountProvider | null>(null);
  const [status, setStatus] = useState(t(language, "settings.providerAccountsReady"));
  const accounts = payload?.accounts ?? [];
  const busy = loading || Boolean(savingProvider);

  const loadAccounts = useCallback(async (options: { quiet?: boolean } = {}) => {
    setLoading(true);
    try {
      const nextPayload = await apiGet<ProviderAccountsResponse>("/api/settings/provider-accounts", { market: marketId });
      setPayload(nextPayload);
      setDrafts(buildDrafts(nextPayload.accounts));
      if (!options.quiet) setStatus(t(language, "settings.providerAccountsReady"));
    } catch (error) {
      if (!options.quiet) setStatus(apiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [language, marketId]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    setStatus(t(language, "settings.providerAccountsReady"));
  }, [language]);

  async function saveAccount(event: FormEvent<HTMLFormElement>, account: ProviderAccountSummary) {
    event.preventDefault();
    const draft = drafts[account.provider] ?? initialDraft(account);
    setSavingProvider(account.provider);
    setStatus(t(language, "settings.providerAccountsSaving", { provider: account.label }));
    void draft;
    try {
      await loadAccounts({ quiet: true });
      setStatus(providerEnvironmentOnlyMessage(language));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setSavingProvider(null);
    }
  }

  async function clearAccount(account: ProviderAccountSummary) {
    setSavingProvider(account.provider);
    setStatus(t(language, "settings.providerAccountsClearing", { provider: account.label }));
    try {
      await loadAccounts({ quiet: true });
      setStatus(providerEnvironmentOnlyMessage(language));
    } catch (error) {
      setStatus(apiErrorMessage(error));
    } finally {
      setSavingProvider(null);
    }
  }

  function updateDraft(provider: ProviderAccountProvider, updater: (draft: ProviderDraft) => ProviderDraft) {
    const account = accounts.find((item) => item.provider === provider);
    setDrafts((current) => ({
      ...current,
      [provider]: updater(current[provider] ?? (account ? initialDraft(account) : { enabled: true, secrets: {}, config: {} })),
    }));
  }

  return (
    <div className="space-y-4">
      <StatusBanner title={loading ? t(language, "settings.providerAccountsLoading") : status} tone={status === t(language, "settings.providerAccountsReady") ? "neutral" : status.includes("saved") || status.includes("已") || status.includes("已儲存") ? "positive" : "neutral"} />
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex flex-col gap-3 border-b border-zinc-100 p-4 dark:border-white/10 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">{t(language, "settings.providerAccountsEyebrow")}</div>
            <div className="mt-2 text-base font-semibold text-zinc-950 dark:text-white">{t(language, "settings.providerAccountsChain")}</div>
          </div>
          <button
            type="button"
            onClick={() => loadAccounts()}
            disabled={busy}
            className="inline-flex h-10 items-center justify-center gap-2 rounded border border-zinc-200 px-4 text-sm font-medium text-zinc-950 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10"
          >
            <RefreshCw size={16} />
            {t(language, "common.reload")}
          </button>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-white/10">
          {accounts.map((account) => {
            const draft = drafts[account.provider] ?? initialDraft(account);
            const secretsVisible = Boolean(visibleSecrets[account.provider]);
            const saving = savingProvider === account.provider;
            const description = providerDescription(language, account);
            const secureNote = t(language, "settings.providerAccountsSecureNote");

            return (
              <form key={account.provider} onSubmit={(event) => saveAccount(event, account)} className="p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex h-9 w-9 items-center justify-center rounded bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                        <KeyRound size={16} />
                      </span>
                      <div className="font-semibold text-zinc-950 dark:text-white">{account.label}</div>
                      <ProviderStatus account={account} language={language} />
                      {account.source !== "missing" ? <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600 dark:bg-white/10 dark:text-zinc-300">{sourceLabel(language, account.source)}</span> : null}
                    </div>
                    {description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">{description}</p> : null}
                  </div>
                  <label className="inline-flex items-center gap-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    <span>{t(language, "settings.providerEnabled")}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={draft.enabled}
                      onClick={() => updateDraft(account.provider, (current) => ({ ...current, enabled: !current.enabled }))}
                      className={`relative h-6 w-11 rounded-full transition ${draft.enabled ? "bg-emerald-600" : "bg-zinc-200 dark:bg-white/10"}`}
                    >
                      <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${draft.enabled ? "left-6" : "left-1"}`} />
                    </button>
                  </label>
                </div>

                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  {account.secretFields.map((field) => (
                    <label key={field.name} className="block">
                      <span className="flex items-center justify-between gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        {fieldLabel(language, field.name, field.label)}
                        {field.configured ? <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500">{field.masked}</span> : null}
                      </span>
                      <div className="mt-2 flex rounded border border-zinc-200 bg-white focus-within:border-emerald-500 dark:border-white/10 dark:bg-white/[0.03]">
                        <input
                          type={secretsVisible ? "text" : "password"}
                          value={draft.secrets[field.name] ?? ""}
                          onChange={(event) => updateDraft(account.provider, (current) => ({ ...current, secrets: { ...current.secrets, [field.name]: event.target.value } }))}
                          placeholder={field.configured ? t(language, "settings.providerSecretKeep") : t(language, "settings.providerSecretPlaceholder")}
                          className="h-10 min-w-0 flex-1 rounded-l bg-transparent px-3 text-sm text-zinc-950 outline-none placeholder:text-zinc-400 dark:text-white dark:placeholder:text-zinc-500"
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          title={secretsVisible ? t(language, "settings.providerHideSecrets") : t(language, "settings.providerShowSecrets")}
                          onClick={() => setVisibleSecrets((current) => ({ ...current, [account.provider]: !secretsVisible }))}
                          className="flex h-10 w-10 items-center justify-center rounded-r text-zinc-500 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-white/10"
                        >
                          {secretsVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </label>
                  ))}
                  {account.configFields.map((field) => (
                    <label key={field.name} className="block">
                      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{fieldLabel(language, field.name, field.label)}</span>
                      {field.options ? (
                        <CustomSelect
                          ariaLabel={fieldLabel(language, field.name, field.label)}
                          className="mt-2"
                          value={draft.config[field.name] ?? field.value ?? ""}
                          options={field.options.map((option) => ({ value: option, label: regionLabel(language, option) }))}
                          onChange={(value) => updateDraft(account.provider, (current) => ({ ...current, config: { ...current.config, [field.name]: value } }))}
                        />
                      ) : (
                        <input
                          value={draft.config[field.name] ?? field.value ?? ""}
                          onChange={(event) => updateDraft(account.provider, (current) => ({ ...current, config: { ...current.config, [field.name]: event.target.value } }))}
                          className="mt-2 h-10 w-full rounded border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none focus:border-emerald-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
                        />
                      )}
                    </label>
                  ))}
                </div>

                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  {secureNote ? <p className="text-sm text-zinc-500 dark:text-zinc-400">{secureNote}</p> : <span />}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => clearAccount(account)}
                      disabled={busy}
                      className="inline-flex h-10 items-center gap-2 rounded border border-zinc-200 px-4 text-sm font-medium text-zinc-950 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10"
                    >
                      <Trash2 size={16} />
                      {t(language, "settings.providerClear")}
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex h-10 items-center gap-2 rounded bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                    >
                      {saving ? <RefreshCw size={16} /> : <Check size={16} />}
                      {t(language, "common.save")}
                    </button>
                  </div>
                </div>
              </form>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function buildDrafts(accounts: ProviderAccountSummary[]): ProviderDrafts {
  return Object.fromEntries(accounts.map((account) => [account.provider, initialDraft(account)])) as ProviderDrafts;
}

function initialDraft(account: ProviderAccountSummary): ProviderDraft {
  return {
    enabled: account.enabled,
    secrets: Object.fromEntries(account.secretFields.map((field) => [field.name, ""])),
    config: Object.fromEntries(account.configFields.map((field) => [field.name, field.value ?? ""])),
  };
}

function ProviderStatus({ account, language }: { account: ProviderAccountSummary; language: Language }) {
  if (!account.enabled) return <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-500 dark:bg-white/10 dark:text-zinc-400">{t(language, "settings.providerDisabled")}</span>;
  if (account.configured) return <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">{t(language, "settings.providerConfigured")}</span>;
  return <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">{t(language, "settings.providerMissing")}</span>;
}

function providerEnvironmentOnlyMessage(language: Language) {
  if (language === "zh-CN") return "托管模式下请在 Hugging Face Secrets 或后端环境变量中配置 provider 凭据；浏览器不会上传或保存密钥。";
  if (language === "zh-TW") return "託管模式下請在 Hugging Face Secrets 或後端環境變數中設定 provider 憑據；瀏覽器不會上傳或保存密鑰。";
  return "Configure provider credentials in Hugging Face Secrets or backend environment variables; browser values are not uploaded or saved.";
}

function sourceLabel(language: Language, source: string) {
  if (source === "local") return t(language, "settings.providerSourceLocal");
  if (source === "environment") return t(language, "settings.providerSourceEnvironment");
  return t(language, "settings.providerSourceMissing");
}

function providerDescription(language: Language, account: ProviderAccountSummary) {
  const key = `settings.provider.${account.provider}.description`;
  const translated = t(language, key);
  return translated === key ? account.description : translated;
}

function fieldLabel(language: Language, name: string, fallback: string) {
  const key = `settings.provider.field.${name}`;
  const translated = t(language, key);
  return translated === key ? fallback : translated;
}

function regionLabel(language: Language, value: string) {
  if (value === "hk") return t(language, "settings.providerRegionHk");
  return t(language, "settings.providerRegionAuto");
}
