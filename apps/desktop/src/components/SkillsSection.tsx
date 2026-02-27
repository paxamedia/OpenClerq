/**
 * Skills section — list skills and edit input/output schemas, dependency mapping.
 */
import { useState, useCallback } from 'react';
import { gateway, type SkillMeta, type SkillsResponse } from '../gateway';

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <pre className={`result-box ${error ? 'error' : ''}`}>{children}</pre>;
}

export function SkillsSection({
  skills,
  onLoad,
  connectionOk,
}: {
  skills: SkillsResponse | string | null;
  onLoad: () => void;
  connectionOk: boolean;
}) {
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ meta: SkillMeta; body: string } | null>(null);
  const [editInputSchema, setEditInputSchema] = useState<string>('');
  const [editOutputSchema, setEditOutputSchema] = useState<string>('');
  const [editDependsOn, setEditDependsOn] = useState<string>('');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const openEditor = useCallback(
    async (slug: string) => {
      setEditingSlug(slug);
      setDetail(null);
      setLoadError(null);
      try {
        const d = await gateway.skill(slug);
        setDetail(d);
        setEditInputSchema(d.meta.inputSchema ? JSON.stringify(d.meta.inputSchema, null, 2) : '{}');
        setEditOutputSchema(d.meta.outputSchema ? JSON.stringify(d.meta.outputSchema, null, 2) : '{}');
        setEditDependsOn(Array.isArray(d.meta.dependsOn) ? d.meta.dependsOn.join(', ') : '');
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    },
    []
  );

  const closeEditor = () => {
    setEditingSlug(null);
    setDetail(null);
    setSaveMessage(null);
  };

  const save = async () => {
    if (!editingSlug) return;
    setSaveMessage(null);
    let inputSchema: Record<string, unknown> | null = null;
    let outputSchema: Record<string, unknown> | null = null;
    let dependsOn: string[] | null = null;
    try {
      const i = editInputSchema.trim();
      inputSchema = i ? (JSON.parse(i) as Record<string, unknown>) : null;
    } catch {
      setSaveMessage('Invalid input schema JSON');
      return;
    }
    try {
      const o = editOutputSchema.trim();
      outputSchema = o ? (JSON.parse(o) as Record<string, unknown>) : null;
    } catch {
      setSaveMessage('Invalid output schema JSON');
      return;
    }
    const d = editDependsOn
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    dependsOn = d.length > 0 ? d : null;
    try {
      await gateway.updateSkill(editingSlug, { inputSchema, outputSchema, dependsOn });
      setSaveMessage('Saved. Reload skills to refresh list.');
      if (detail) {
        setDetail({
          ...detail,
          meta: {
            ...detail.meta,
            inputSchema: inputSchema ?? undefined,
            outputSchema: outputSchema ?? undefined,
            dependsOn: dependsOn ?? undefined,
          },
        });
      }
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const skillsList =
    skills && typeof skills !== 'string' ? skills.skills : [];
  const allSlugs = new Set(skillsList.map((s) => s.slug));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <p className="section-desc" style={{ marginBottom: 0 }}>
        Modular skills from the directory in Settings. Edit schemas and dependencies (Builder mode).
      </p>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button type="button" className="btn" onClick={onLoad} disabled={!connectionOk}>
          Load skills
        </button>
      </div>
      {skills === null ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Click Load skills to fetch from the gateway.</p>
      ) : typeof skills === 'string' ? (
        <ResultBox error>{skills}</ResultBox>
      ) : skills.skills.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>No skills found in {skills.source}</p>
      ) : (
        <>
          <p className="skills-source">Loaded from: {skills.source}</p>
          <div className="skills-grid">
            {skills.skills.map((s) => (
              <button
                key={s.slug}
                type="button"
                className={`skill-chip ${editingSlug === s.slug ? 'skill-chip--active' : ''}`}
                onClick={() => openEditor(s.slug)}
              >
                <strong>{s.name}</strong>
                {s.version && <span className="skill-chip__version">v{s.version}</span>}
                {s.description && <span className="skill-desc"> — {s.description}</span>}
                {(s.inputSchema || s.outputSchema || (s.dependsOn && s.dependsOn.length > 0)) && (
                  <span style={{ marginLeft: 4, fontSize: '0.75rem', color: 'var(--text-muted)' }}>⚙</span>
                )}
              </button>
            ))}
          </div>

          {editingSlug && (
            <div
              className="skill-editor"
              style={{
                marginTop: '1rem',
                padding: '1rem',
                background: 'var(--surface)',
                borderRadius: 8,
                border: '1px solid var(--card-border)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0, fontSize: '1rem' }}>Edit {detail?.meta?.name ?? editingSlug}</h3>
                <button type="button" className="btn btn-ghost" onClick={closeEditor}>
                  Close
                </button>
              </div>
              {loadError && (
                <ResultBox error>{loadError}</ResultBox>
              )}
              {detail && !loadError && (
                <>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                    <span>Input schema (JSON)</span>
                    <textarea
                      value={editInputSchema}
                      onChange={(e) => setEditInputSchema(e.target.value)}
                      rows={6}
                      style={{
                        display: 'block',
                        width: '100%',
                        fontFamily: 'monospace',
                        fontSize: '0.85rem',
                        marginTop: 4,
                        padding: 8,
                      }}
                    />
                  </label>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                    <span>Output schema (JSON)</span>
                    <textarea
                      value={editOutputSchema}
                      onChange={(e) => setEditOutputSchema(e.target.value)}
                      rows={6}
                      style={{
                        display: 'block',
                        width: '100%',
                        fontFamily: 'monospace',
                        fontSize: '0.85rem',
                        marginTop: 4,
                        padding: 8,
                      }}
                    />
                  </label>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                    <span>Depends on (skill slugs, comma-separated)</span>
                    <input
                      type="text"
                      value={editDependsOn}
                      onChange={(e) => setEditDependsOn(e.target.value)}
                      placeholder="e.g. vat-core, payroll-base"
                      style={{ display: 'block', width: '100%', marginTop: 4 }}
                    />
                  </label>
                  {editDependsOn.trim() && (
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
                      Dependency graph:{' '}
                      {editDependsOn
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .map((slug) => (allSlugs.has(slug) ? slug : `${slug} ⚠ unknown`))
                        .join(' → ')}
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
                    <button type="button" className="btn" onClick={save}>
                      Save
                    </button>
                    {saveMessage && <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{saveMessage}</span>}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
