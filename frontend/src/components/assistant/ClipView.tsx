import { useEffect, useRef, useState } from "react";
import { api, urls } from "../../api/client";
import type { AudioAnalysis, ClipBlock, ClipJob, Passport, Shot } from "../../api/clip-types";
import type { Generation } from "../../api/types";
import { applyClipBlock, assembleClip, clipEdit, clipOperation } from "../../lib/actions";
import { useClip } from "../../store/clip";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, ErrorMessage, Select, Spinner } from "../ui";
import { Markdown } from "./Markdown";
import { ChatView } from "./ChatView";

const passportLabels: Record<keyof Passport, string> = {
  concept: "Концепция", hero: "Герой и внешность", costume: "Костюм", locations: "Локации",
  palette: "Палитра", constraints: "Ограничения", aspect: "Формат", lipsync: "Где нужен липсинк",
};
const cameraLabels = { support: "Крепление", start: "Старт", path: "Траектория", orientation: "Ориентация",
  lens_focus: "Оптика и фокус", speed: "Скорость", anchor_parallax: "Якорь и параллакс", end: "Конечный кадр" };
const fieldClass = "w-full rounded-lg border border-line bg-raised p-2 text-xs outline-none focus:border-accent";
const time = (n: number) => `${Math.floor(n / 60)}:${(n % 60).toFixed(2).padStart(5, "0")}`;
const running = (j: ClipJob) => j.status === "queued" || j.status === "running";

export function AssistantWorkspace() {
  const [mode, setMode] = useState<"chat" | "clip">(() => localStorage.getItem("sm.assistantMode") === "clip" ? "clip" : "chat");
  return <div className="flex h-full flex-col">
    <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-2">
      <Button variant={mode === "chat" ? "primary" : "ghost"} onClick={() => { setMode("chat"); localStorage.setItem("sm.assistantMode", "chat"); }}>Чат</Button>
      <Button variant={mode === "clip" ? "primary" : "ghost"} onClick={() => { setMode("clip"); localStorage.setItem("sm.assistantMode", "clip"); }}>Клип</Button>
      <span className="ml-2 text-xs text-muted">{mode === "clip" ? "Идея → постановка → черновик → финал" : "Идеи сцен и промпты"}</span>
    </div>
    <div className="min-h-0 flex-1">{mode === "clip" ? <ClipView /> : <ChatView />}</div>
  </div>;
}

function useAction() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; setPending(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setPending(false); }
  };
  return { error, pending, run };
}

function ClipView() {
  const { active, list, load, open } = useClip();
  const pid = useUI((s) => s.projectId);
  const [creating, setCreating] = useState(false);
  const action = useAction();
  useEffect(() => { void action.run(load); }, [pid]); // project-scoped restoration
  useEffect(() => {
    const id = setInterval(() => { void useClip.getState().refresh().catch(() => undefined); }, 5000);
    return () => clearInterval(id);
  }, []);
  return <div className="flex h-full min-h-0">
    <aside className="w-52 shrink-0 overflow-y-auto border-r border-line bg-panel p-3">
      <Button variant="outline" onClick={() => setCreating(true)}>Новый клип</Button>
      <div className="mt-4 space-y-1">{list.map((p) => <button key={p.id}
        className={`w-full rounded-lg px-2 py-2 text-left text-xs ${active?.id === p.id && !creating ? "bg-hover text-fg" : "text-muted"}`}
        onClick={() => { setCreating(false); void action.run(() => open(p.id)); }}>{p.name}</button>)}</div>
      <p className="mt-6 text-[11px] text-faint">Решения и задания сохраняются на сервере. Генерации запускаются по блокам после вашей команды.</p>
      {action.error && <ErrorMessage text={action.error} className="mt-3" />}
    </aside>
    <main className="min-w-0 flex-1 overflow-auto">
      {creating || !active ? <CreateClip onCreated={() => { setCreating(false); void load(); }} /> : <ClipProjectView key={active.id} />}
    </main>
  </div>;
}

function CreateClip({ onCreated }: { onCreated: () => void }) {
  const assets = useLibrary((s) => s.assets);
  const audios = Object.values(assets).filter((a) => a.kind === "audio");
  const [idea, setIdea] = useState("");
  const [audioId, setAudioId] = useState("");
  const [refs, setRefs] = useState<{ id: string; name: string }[]>([]);
  const audioInput = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const action = useAction();
  return <div className="mx-auto max-w-2xl space-y-5 p-8">
    <h2 className="text-xl font-medium">Разработаем клип</h2>
    <p className="text-sm text-muted">Добавьте трек, опишите простую идею и приложите своих героев. Обсудим замысел, затем поставим и проверим первый блок.</p>
    <textarea className={fieldClass} rows={4} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Например: герой пытается оставаться незаметным в городе, который реагирует на каждое его движение…" aria-label="Идея клипа" />
    <Select label="Аудиотрек" value={audioId} onChange={setAudioId} options={[{ value: "", label: "Выберите трек" }, ...audios.map((a) => ({ value: String(a.id), label: a.name }))]} />
    <div className="flex gap-2">
      <Button variant="outline" disabled={action.pending} onClick={() => audioInput.current?.click()}>Загрузить аудио</Button>
      <Button variant="outline" disabled={action.pending} onClick={() => refInput.current?.click()}>Добавить референсы</Button>
    </div>
    <input type="file" accept="audio/*" hidden ref={audioInput} onChange={(e) => {
      const file = e.target.files?.[0]; if (!file) return;
      void action.run(async () => { const a = await api.importAsset(file); useLibrary.getState().upsertAsset(a); setAudioId(String(a.id)); }); e.target.value = "";
    }} />
    <input type="file" accept="image/*,video/*" multiple hidden ref={refInput} onChange={(e) => {
      const files = Array.from(e.target.files ?? []);
      void action.run(async () => { for (const file of files) { const up = await api.upload(file); setRefs((r) => [...r, { id: up.id, name: up.orig_name }]); } }); e.target.value = "";
    }} />
    <div className="flex flex-wrap gap-2">{refs.map((r) => <button key={r.id} className="rounded bg-raised p-2 text-xs" onClick={() => setRefs(refs.filter((x) => x.id !== r.id))}>{r.name} ×</button>)}</div>
    <Button disabled={action.pending || !idea.trim() || !audioId} onClick={() => void action.run(async () => {
      useClip.getState().setActive(await api.createClipProject({ project_id: useUI.getState().projectId, idea, audio_asset_id: Number(audioId), ref_ids: refs.map((r) => r.id) })); onCreated();
    })}>{action.pending ? <Spinner size={14} /> : null} Начать разработку</Button>
    {action.error && <ErrorMessage text={action.error} />}
  </div>;
}

function AutoField({ label, value, save, rows = 2, disabled = false }: { label: string; value: string; save: (value: string) => Promise<unknown>; rows?: number; disabled?: boolean }) {
  const [text, setText] = useState(value);
  const action = useAction();
  useEffect(() => setText(value), [value]);
  return <label className="block space-y-1 text-xs text-muted">{label}
    <textarea className={fieldClass} rows={rows} value={text} disabled={disabled || action.pending}
      onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== value) void action.run(() => save(text)); }} />
    {action.error && <ErrorMessage text={action.error} />}
  </label>;
}

function ClipProjectView() {
  const clip = useClip((s) => s.active)!;
  const doc = clip.document;
  const [message, setMessage] = useState("");
  const [blockId, setBlockId] = useState("");
  const action = useAction();
  const busy = clip.jobs.find(running);
  const proposal = clip.jobs.find((j) => j.status === "done" && j.base_revision === clip.revision && ["analyze", "treatment", "develop"].includes(j.kind));
  const latestError = clip.jobs[0]?.error;
  const block = doc.blocks.find((b) => b.id === blockId) ?? doc.blocks.find((b) => !b.versions.at(-1)?.final_approved) ?? doc.blocks[0];
  const refs = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLInputElement>(null);
  const disabled = !!busy || action.pending;
  return <div className="mx-auto max-w-6xl space-y-5 p-5">
    <div className="flex items-center justify-between gap-4"><div><h2 className="text-lg font-medium">{doc.name}</h2>
      <p className="text-xs text-muted">{time(doc.audio_end - doc.audio_start)} · {doc.passport_approved ? "Паспорт утверждён" : "Обсуждаем замысел"}</p></div>
      <Button variant="outline" disabled={disabled || !doc.blocks.length || doc.blocks.some((b) => b.stale || !b.versions.at(-1)?.final_approved)} onClick={() => void action.run(assembleClip)}>Собрать клип</Button>
    </div>
    <p className="text-[11px] text-faint">Сборка заменит видеодорожку и включит музыку клипа. Ctrl+Z вернёт предыдущий монтаж.</p>
    {busy && <div role="status" className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 p-3 text-xs">
      <Spinner size={14} /><span className="flex-1">{busy.stage} {busy.progress > 0 ? `${Math.round(busy.progress * 100)}%` : ""}</span>
      <Button size="sm" variant="ghost" onClick={() => void action.run(() => api.stopClipJob(clip.id, busy.id))}>Остановить</Button>
    </div>}
    {(action.error || latestError) && <ErrorMessage text={action.error || latestError!} />}
    {clip.jobs[0]?.status === "interrupted" && <p className="text-xs text-muted">Операция прервана перезапуском. Повторите её; утверждённая работа сохранена.</p>}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 space-y-4">
        <div className="rounded-xl border border-line bg-panel p-4">
          <h3 className="mb-3 text-sm font-medium">Обсуждение</h3>
          <div className="max-h-96 space-y-4 overflow-auto text-sm">
            <p className="text-muted">{doc.idea}</p>
            {doc.messages.map((m, i) => <div key={i} className={m.role === "user" ? "rounded-lg bg-accent/10 p-3" : "px-1"}><Markdown text={m.content} /></div>)}
          </div>
          <textarea className={`${fieldClass} mt-4`} rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Обсудим героя, концепцию или конкретную правку…" aria-label="Обсуждение клипа" disabled={disabled} />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button disabled={disabled || !message.trim()} onClick={() => void action.run(async () => { await clipOperation({ kind: "discuss", text: message }); setMessage(""); })}>Обсудить</Button>
            <Button variant="outline" disabled={disabled} onClick={() => void action.run(() => clipOperation({ kind: "discuss", text: "Предложи 2–3 разные режиссёрские концепции по моей идее и треку. Если не хватает ключевых данных, сначала уточни их." }))}>Предложить концепции</Button>
            <Button variant="outline" disabled={disabled} onClick={() => void action.run(() => clipOperation({ kind: "treatment", text: message }))}>Предложить паспорт и блоки</Button>
          </div>
        </div>
        {proposal && <section className="space-y-3 rounded-xl border border-accent/40 bg-panel p-4">
          <h3 className="text-sm font-medium">Предложение — ещё не применено</h3>
          {proposal.result.analysis && <AudioSummary analysis={proposal.result.analysis} editable={false} />}
          {proposal.result.passport && <dl className="space-y-2 text-xs">{Object.entries(proposal.result.passport).map(([key, value]) => <div key={key}><dt className="text-muted">{passportLabels[key as keyof Passport]}</dt><dd>{value}</dd></div>)}</dl>}
          {proposal.result.blocks?.map((b) => <p key={b.id} className="text-xs"><b>{time(b.start)}–{time(b.end)} · {b.name}</b><br />{b.intent}</p>)}
          {proposal.result.shots?.map((shot) => <ShotDetails key={shot.id} shot={shot} />)}
          {proposal.result.review?.map((note, i) => <p key={i} className="text-xs text-muted">{note}</p>)}
          <Button disabled={disabled} onClick={() => void action.run(async () => { useClip.getState().setActive(await api.acceptClipProposal(clip.id, proposal.id, clip.revision)); })}>Принять предложение</Button>
        </section>}
        {doc.blocks.length > 0 && <>
          <Select label="Блок клипа" value={block?.id ?? ""} onChange={setBlockId} options={doc.blocks.map((b) => ({ value: b.id, label: `${time(b.start)}–${time(b.end)} · ${b.name}${b.versions.at(-1)?.final_approved ? " ✓" : ""}` }))} />
          {block && <BlockView key={`${block.id}:${block.versions.at(-1)?.version ?? 0}`} block={block} disabled={disabled} />}
        </>}
      </section>
      <aside className="space-y-4">
        <section className="space-y-3 rounded-xl border border-line bg-panel p-4">
          <h3 className="text-sm font-medium">Трек и референсы</h3>
          <audio controls src={urls.assetFile(doc.audio_asset_id)} className="w-full" />
          <p className="text-[11px] text-faint">Интервал в исходном файле: {time(doc.audio_start)}–{time(doc.audio_end)}. Кадры отсчитываются от начала клипа.</p>
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => void action.run(() => clipOperation({ kind: "analyze" }))}>{doc.analysis ? "Повторить анализ" : "Разобрать трек"}</Button>
            <Button size="sm" variant="ghost" onClick={() => useUI.getState().openSettings("assistant")}>Модель аудио</Button></div>
          <details><summary className="cursor-pointer text-xs text-muted">Границы и исходники</summary><div className="mt-2 space-y-2">
            <AutoField label="Начало, секунды" value={String(doc.audio_start)} rows={1} disabled={disabled} save={(value) => clipEdit({ audio_start: Number(value) })} />
            <AutoField label="Конец, секунды" value={String(doc.audio_end)} rows={1} disabled={disabled} save={(value) => clipEdit({ audio_end: Number(value) })} />
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => audio.current?.click()}>Заменить трек</Button>
            <input hidden ref={audio} type="file" accept="audio/*" onChange={(e) => { const file = e.target.files?.[0]; if (file) void action.run(async () => { const a = await api.importAsset(file); useLibrary.getState().upsertAsset(a); await clipEdit({ audio_asset_id: a.id, audio_start: 0, audio_end: a.duration ?? 0 }); }); e.target.value = ""; }} />
          </div></details>
          <div className="flex flex-wrap gap-2">{doc.ref_ids.map((id) => <div key={id} className="relative"><img src={urls.uploadThumb(id)} className="h-14 w-14 rounded object-cover" alt="Референс клипа" /><button disabled={disabled} className="absolute right-0 top-0 bg-panel px-1 text-xs" aria-label="Убрать референс" onClick={() => void action.run(() => clipEdit({ ref_ids: doc.ref_ids.filter((r) => r !== id) }))}>×</button></div>)}</div>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => refs.current?.click()}>Добавить референсы</Button>
          <input hidden ref={refs} type="file" accept="image/*,video/*" multiple onChange={(e) => { const files = Array.from(e.target.files ?? []); void action.run(async () => { const ids = [...doc.ref_ids]; for (const file of files) ids.push((await api.upload(file)).id); await clipEdit({ ref_ids: ids }); }); e.target.value = ""; }} />
          {doc.analysis && <details open><summary className="cursor-pointer text-xs">Музыкальная разметка и слова</summary><AudioSummary analysis={doc.analysis} editable={!disabled} /></details>}
        </section>
        <section className="space-y-3 rounded-xl border border-line bg-panel p-4">
          <h3 className="text-sm font-medium">Паспорт клипа</h3>
          <p className="text-[11px] text-faint">Правки сохраняются при выходе из поля. Изменение канона требует пересмотра блоков.</p>
          {(Object.keys(passportLabels) as (keyof Passport)[]).filter((key) => key !== "aspect").map((key) => <AutoField key={key} label={passportLabels[key]} value={doc.passport[key]} disabled={disabled}
            save={(value) => clipEdit({ passport: { ...useClip.getState().active!.document.passport, [key]: value } })} />)}
          <fieldset disabled={disabled}><Select label="Формат" value={doc.passport.aspect} onChange={(value) => void action.run(() => clipEdit({ passport: { ...doc.passport, aspect: value } }))}
            options={["16:9 (Widescreen)", "9:16 (Portrait Widescreen)", "1:1 (Square)", "4:3 (Standard)", "2:3 (Portrait Photo)", "3:2 (Photo)", "3:4 (Portrait Standard)", "21:9 (Ultrawide)"].map((value) => ({ value, label: value.split(" ")[0] }))} /></fieldset>
          <fieldset disabled={disabled}><Select label="Качество финала" value={doc.quality} onChange={(quality) => void action.run(() => clipEdit({ quality: quality as "standard" | "high" }))} options={[{ value: "standard", label: "Стандарт" }, { value: "high", label: "Высокое" }]} /></fieldset>
          {!doc.passport_approved && <Button size="sm" disabled={disabled || !doc.passport.concept.trim()} onClick={() => void action.run(async () => { useClip.getState().setActive(await api.approveClipPassport(clip.id, clip.revision)); })}>Утвердить паспорт</Button>}
        </section>
        <details className="rounded-xl border border-line p-3"><summary className="cursor-pointer text-xs">История операций</summary>
          {clip.jobs.map((j) => <details key={j.id} className="mt-2 text-xs"><summary>{j.stage} · {Math.round(j.progress * 100)}%</summary>
            {j.error && <ErrorMessage text={j.error} />}
            {j.result.text && <Markdown text={j.result.text} />}
            {j.result.previous_document && <details><summary>Предыдущая концепция: {j.result.previous_document.passport.concept}</summary>
              {j.result.previous_document.blocks.map((b) => <div key={b.id}><p>{b.name}</p>{b.versions.map((v) => <details key={v.version}><summary>Версия {v.version}</summary>{v.shots.map((s) => <ShotDetails key={s.id} shot={s} />)}</details>)}</div>)}
            </details>}
            {j.result.shots?.map((s) => <ShotDetails key={s.id} shot={s} />)}
          </details>)}
        </details>
        <RevisionHistory clipId={clip.id} revision={clip.revision} />
      </aside>
    </div>
  </div>;
}

function RevisionHistory({ clipId, revision }: { clipId: string; revision: number }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.clipRevisions>>>([]);
  const action = useAction();
  return <details className="rounded-xl border border-line p-3" onToggle={(e) => { if (e.currentTarget.open) void action.run(async () => setItems(await api.clipRevisions(clipId))); }}>
    <summary className="cursor-pointer text-xs">История паспорта и утверждений · {revision}</summary>
    {items.map((item) => <details key={item.revision} className="mt-2 text-xs"><summary>Версия проекта {item.revision} · {item.document.passport_approved ? "паспорт утверждён" : "обсуждение"}</summary>
      <dl>{Object.entries(item.document.passport).map(([key, value]) => <div key={key} className="mt-2"><dt className="text-muted">{passportLabels[key as keyof Passport]}</dt><dd>{value}</dd></div>)}</dl>
      {item.document.blocks.map((b) => <p key={b.id} className="mt-2">{b.name} · {b.versions.at(-1)?.final_approved ? "финал утверждён" : b.versions.at(-1)?.draft_approved ? "черновик утверждён" : "в разработке"}</p>)}
    </details>)}
    {action.error && <ErrorMessage text={action.error} />}
  </details>;
}

function AudioSummary({ analysis, editable }: { analysis: AudioAnalysis; editable: boolean }) {
  const action = useAction();
  const max = Math.max(0.001, ...analysis.energy.map((p) => p[1]));
  const points = analysis.energy.map(([t, e]) => `${(t - analysis.start) / (analysis.end - analysis.start) * 600},${50 - e / max * 45}`).join(" ");
  return <div className="mt-3 space-y-3 text-xs">
    <svg viewBox="0 0 600 55" className="w-full text-accent" aria-label="Изменение энергии трека"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
    <p className="text-faint">{analysis.beats.length} акцентов · {analysis.pauses.length} пауз · {analysis.repetitions.length} вероятных повторов</p>
    {analysis.sections.map((section, i) => <details key={i}><summary className="cursor-pointer">{time(section.start)}–{time(section.end)} · {section.label}{section.tentative ? " ≈" : ""}</summary>
      {editable && <div className="mt-2 space-y-1">{(["label", "start", "end"] as const).map((key) => <AutoField key={key} label={key === "label" ? "Название части" : key === "start" ? "Начало, секунды" : "Конец, секунды"} value={String(section[key])} rows={1}
        save={(value) => { const current = useClip.getState().active!.document.analysis!.sections; return clipEdit({ sections: current.map((s, j) => {
          if (j === i) return { ...s, [key]: key === "label" ? value : Number(value), tentative: false };
          if (key === "start" && j === i - 1) return { ...s, end: Number(value) };
          if (key === "end" && j === i + 1) return { ...s, start: Number(value) };
          return s;
        }) }); }} />)}</div>}
    </details>)}
    {editable ? <AutoField label="Текст песни — можно исправить целиком" value={analysis.lyrics} rows={5} save={(lyrics) => clipEdit({ lyrics })} /> : <p className="max-h-48 overflow-auto whitespace-pre-wrap">{analysis.lyrics || "Слова не распознаны"}</p>}
    <details><summary className="cursor-pointer text-muted">Слова с таймкодами</summary><div className="max-h-48 overflow-auto leading-6">{analysis.words.map((w, i) => <span key={i} className={w.probability < 0.7 ? "text-amber-400" : "text-muted"} title={`${time(w.start)}–${time(w.end)} · ${Math.round(w.probability * 100)}%`}>{w.word} </span>)}</div><p className="text-faint">Жёлтым — неуверенное распознавание. Исправленный текст выше имеет приоритет.</p></details>
    {analysis.warnings.map((w, i) => <p key={i} className="text-[11px] text-faint">{w}</p>)}
    {action.error && <ErrorMessage text={action.error} />}
  </div>;
}

function ShotDetails({ shot }: { shot: Shot }) {
  return <details className="rounded-lg border border-line p-3 text-xs"><summary className="cursor-pointer font-medium">{time(shot.start)} · {shot.duration.toFixed(2)} с · {shot.name}{shot.lipsync ? " · липсинк" : ""}</summary>
    <div className="mt-3 space-y-2"><p><b>Идея:</b> {shot.idea}</p><p><b>Действие:</b> {shot.action}</p><p><b>Музыка:</b> {shot.music}</p>
      <p><b>Герой:</b> {shot.subject_motion}</p><p><b>Среда:</b> {shot.background_motion}</p><p><b>Склейки:</b> {shot.incoming_cut} → {shot.outgoing_cut}</p><p><b>Свет:</b> {shot.light}</p>
      <details><summary className="cursor-pointer text-muted">Карта поведения камеры</summary><dl className="mt-2 space-y-1">{Object.entries(shot.camera).map(([key, value]) => <div key={key}><dt className="text-muted">{cameraLabels[key as keyof typeof cameraLabels]}</dt><dd>{value}</dd></div>)}</dl></details>
      <details><summary className="cursor-pointer text-muted">H3-промпт</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[11px] text-muted">{shot.prompt || "Будет составлен после постановки"}</pre></details>
    </div>
  </details>;
}

function takeInfo(g: Generation) { return (g.info ?? {}) as { block_id?: string; block_version?: number; shot_id?: string; plan_mode?: string }; }

function BlockView({ block, disabled }: { block: ClipBlock; disabled: boolean }) {
  const clip = useClip((s) => s.active)!;
  const version = block.versions.at(-1);
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<"draft" | "final">(version?.draft_approved ? "final" : "draft");
  const [selections, setSelections] = useState<Record<string, number>>({});
  const action = useAction();
  const jobs = clip.jobs.filter((j) => j.request.block_id === block.id && j.status === "done");
  const picks: Record<string, number> = {};
  for (const shot of version?.shots ?? []) {
    const candidates = clip.takes.filter((g) => { const info = takeInfo(g); return info.block_id === block.id && info.block_version === version?.version && info.shot_id === shot.id && info.plan_mode === mode && ["done", "draft_only"].includes(g.status); });
    const preferred = selections[shot.id] ?? (mode === "draft" ? version?.selected_draft : version?.selected_final)?.[shot.id];
    const chosen = candidates.find((g) => g.id === preferred) ?? candidates.at(-1);
    if (chosen) picks[shot.id] = chosen.id;
  }
  const ready = !!version?.shots.length && version.shots.every((s) => picks[s.id]);
  const matchesPicks = (j: ClipJob) => j.request.mode === mode && j.base_revision === clip.revision
    && Object.entries(picks).every(([id, take]) => j.request.selections?.[id] === take);
  const preview = jobs.find((j) => j.kind === "preview" && matchesPicks(j));
  const review = jobs.find((j) => j.kind === "review" && matchesPicks(j));
  const blocked = disabled || action.pending;
  return <section className="space-y-3 rounded-xl border border-line bg-panel p-4">
    <h3 className="text-sm font-medium">{block.name} {version ? `· версия ${version.version}` : ""}</h3><p className="text-xs text-muted">{block.intent}</p>
    {block.stale && <p className="text-xs text-amber-400">Изменился паспорт, референсы или музыка. Разработайте новую версию блока.</p>}
    <textarea className={fieldClass} rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Что исправить в этом блоке: действие, ритм, камера…" aria-label="Правка блока" disabled={blocked} />
    <Button variant="outline" disabled={blocked || !clip.document.passport_approved} onClick={() => void action.run(() => clipOperation({ kind: "develop", block_id: block.id, text: instruction }))}>{version ? "Предложить новую версию" : "Разработать блок"}</Button>
    {version && <>
      <Button size="sm" variant="ghost" disabled={blocked || block.stale} onClick={() => void action.run(() => applyClipBlock(block.id, true))}>Применить постановку на таймлайн</Button>
      <p className="text-[11px] text-faint">Это действие заменяет планы этого блока и его музыкальную дорожку. Ctrl+Z отменит замену. Повторная генерация сохраняет ручные правки; при конфликте потребуется явно применить постановку.</p>
      <div className="flex gap-2">{(["draft", "final"] as const).map((m) => <Button key={m} size="sm" variant={mode === m ? "primary" : "ghost"} onClick={() => { setMode(m); setSelections({}); }}>{m === "draft" ? "Черновики" : "Финалы"}</Button>)}</div>
      {version.shots.map((shot) => {
        const candidates = clip.takes.filter((g) => { const info = takeInfo(g); return info.block_id === block.id && info.block_version === version.version && info.shot_id === shot.id && info.plan_mode === mode; });
        const selected = candidates.find((g) => g.id === picks[shot.id]);
        return <div key={shot.id} className="space-y-2"><ShotDetails shot={shot} />
          {candidates.length > 0 && <Select label="Дубль" value={String(picks[shot.id] ?? "")} options={[{ value: "", label: "Нет готового дубля" }, ...candidates.filter((g) => ["done", "draft_only"].includes(g.status)).map((g) => ({ value: String(g.id), label: `#${g.id} · готов` }))]} onChange={(value) => setSelections({ ...selections, [shot.id]: Number(value) })} />}
          {candidates.filter((g) => !["done", "draft_only"].includes(g.status)).map((g) => <p key={g.id} className="text-[11px] text-muted">Дубль #{g.id}: {g.status === "error" ? g.error : g.status === "cancelled" ? "остановлен" : "в обработке"}</p>)}
          {selected && <details><summary className="cursor-pointer text-xs text-muted">Посмотреть выбранный дубль</summary><video controls muted className="mt-2 max-h-72 w-full rounded-lg" src={urls.assetFile(selected.output_asset_id ?? selected.draft_asset_id!)} /></details>}
          {selected && <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={blocked} onClick={() => useUI.getState().openFaceDialog({ assetId: selected.output_asset_id ?? selected.draft_asset_id! })}>Улучшить лицо</Button>
            <Button size="sm" variant="ghost" disabled={blocked} onClick={() => useUI.getState().openEnhanceDialog({ assetId: selected.output_asset_id ?? selected.draft_asset_id! })}>Детализация SeedVR2</Button>
          </div>}
          {selected && clip.takes.some((g) => g.id !== selected.id && takeInfo(g).shot_id === shot.id && ["done", "draft_only"].includes(g.status)) &&
            <Select label="Сравнить выбранный дубль" value="" options={[{ value: "", label: "Выберите второй дубль для A/B" }, ...clip.takes.filter((g) => g.id !== selected.id && takeInfo(g).shot_id === shot.id && ["done", "draft_only"].includes(g.status)).map((g) => ({ value: String(g.id), label: `#${g.id} · ${takeInfo(g).plan_mode === "final" ? "финал" : "черновик"}` }))]} onChange={(value) => {
              if (!value) return;
              const ui = useUI.getState(); ui.selectGen(selected.id); ui.compare(Number(value)); ui.setWorkspace("generate");
            }} />}
          <Button size="sm" variant="ghost" disabled={blocked || block.stale || (mode === "final" && !version.draft_approved)} onClick={() => void action.run(async () => { await applyClipBlock(block.id); await clipOperation({ kind: "generate", block_id: block.id, mode, shot_ids: [shot.id] }); })}>Новый дубль этого кадра</Button>
        </div>;
      })}
      <div className="flex flex-wrap gap-2">
        <Button disabled={blocked || block.stale || (mode === "final" && !version.draft_approved)} onClick={() => void action.run(async () => { await applyClipBlock(block.id); await clipOperation({ kind: "generate", block_id: block.id, mode }); })}>{mode === "draft" ? "Создать черновик блока" : "Создать финал блока"}</Button>
        <Button variant="outline" disabled={blocked || block.stale || !ready} onClick={() => void action.run(() => clipOperation({ kind: "preview", block_id: block.id, mode, selections: picks }))}>Смотреть блок с музыкой</Button>
        <Button variant="ghost" disabled={blocked || block.stale || !ready} onClick={() => void action.run(() => clipOperation({ kind: "review", block_id: block.id, mode, selections: picks }))}>Проверить кадры ассистентом</Button>
      </div>
      {preview?.result.asset_id && <video controls className="w-full rounded-xl" src={urls.assetFile(preview.result.asset_id)} />}
      {review && <details className="space-y-2 text-xs"><summary className="cursor-pointer">Замечания ассистента по кадрам</summary>{review.result.technical?.map((t, i) => <p key={i} className="text-bad">{t}</p>)}{review.result.observations?.map((t, i) => <Markdown key={i} text={t} />)}<p className="text-muted">{review.result.notice}</p></details>}
      <p className="text-[11px] text-faint">Перед утверждением просмотрите движение, контакты, склейки и липсинк с музыкой. Финальная генерация может отличаться от черновика.</p>
      <Button variant="outline" disabled={blocked || block.stale || !ready} onClick={() => void action.run(async () => { useClip.getState().setActive(await api.approveClipBlock(clip.id, block.id, clip.revision, mode, picks)); if (mode === "draft") { setMode("final"); setSelections({}); } })}>Просмотрено — утвердить {mode === "draft" ? "черновик" : "финал"}</Button>
      {block.versions.length > 1 && <details><summary className="cursor-pointer text-xs text-muted">Предыдущие версии постановки</summary>{block.versions.slice(0, -1).map((v) => <div key={v.version}><p className="mt-2 text-xs">Версия {v.version}</p>{v.shots.map((s) => <ShotDetails key={s.id} shot={s} />)}</div>)}</details>}
    </>}
    {action.error && <ErrorMessage text={action.error} />}
  </section>;
}
