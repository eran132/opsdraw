import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { installedPacks, isReservedPrefix, removePack, savePack } from './icons';
import { importPackZip } from './packs';
import { usePacksVersion } from './Icon';

/** Where users get official packs. Links only; nothing is downloaded by the app. */
const VENDOR_PAGES = [
  {
    prefix: 'aws',
    name: 'AWS Architecture Icons',
    url: 'https://aws.amazon.com/architecture/icons/',
  },
  {
    prefix: 'azure',
    name: 'Azure architecture icons',
    url: 'https://learn.microsoft.com/azure/architecture/icons/',
  },
  { prefix: 'gcp', name: 'Google Cloud icons', url: 'https://cloud.google.com/icons' },
];

export function PackDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const [prefix, setPrefix] = useState('aws');
  const [file, setFile] = useState<File | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  usePacksVersion();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const prefixError = !/^[a-z][a-z0-9-]*$/.test(prefix)
    ? t('packs.invalidPrefix')
    : isReservedPrefix(prefix)
      ? t('packs.reservedPrefix', { prefix })
      : '';

  async function doImport() {
    if (!file) return;
    setBusy(true);
    setMessage('');
    try {
      const pack = await importPackZip(file, prefix, file.name.replace(/\.zip$/i, ''));
      const count = Object.keys(pack.icons).length;
      if (!count) {
        setMessage(t('packs.noSvg'));
        return;
      }
      await savePack(pack);
      setMessage(t('packs.imported', { count, prefix }));
      setFile(null);
      setAccepted(false);
    } catch (e) {
      setMessage(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose}>
      <h2>{t('packs.title')}</h2>
      <p>{t('packs.intro')}</p>
      <p className="muted">{t('packs.terms')}</p>
      <ul className="vendor-links" dir="ltr">
        {VENDOR_PAGES.map((v) => (
          <li key={v.prefix}>
            <a href={v.url} target="_blank" rel="noreferrer noopener">
              {v.name}
            </a>{' '}
            <code>{v.prefix}:</code>
          </li>
        ))}
      </ul>
      <label>
        {t('packs.prefix')}
        <input
          dir="ltr"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value.trim().toLowerCase())}
        />
        {prefixError && <span className="field-error">{prefixError}</span>}
      </label>
      <label>
        {t('packs.file')}
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        {t('packs.accept')}
      </label>
      <div className="row">
        <button
          className="primary"
          disabled={!file || !accepted || !!prefixError || busy}
          onClick={doImport}
        >
          {busy ? t('packs.importing') : t('packs.import')}
        </button>
        <span role="status">{message}</span>
      </div>
      {installedPacks().length > 0 && (
        <>
          <h3>{t('packs.installed')}</h3>
          <ul className="pack-list">
            {installedPacks().map((p) => (
              <li key={p.prefix}>
                <code>{p.prefix}:</code> <span dir="auto">{p.name}</span>{' '}
                <span className="muted">
                  {t('packs.icons', { count: Object.keys(p.icons).length })}
                </span>{' '}
                <button onClick={() => void removePack(p.prefix)}>{t('packs.remove')}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row end">
        <button onClick={onClose}>{t('packs.close')}</button>
      </div>
    </dialog>
  );
}
