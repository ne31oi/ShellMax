import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { RefModLimits } from "../../api/types";
import { useForm } from "../../store/form";
import { useLibrary } from "../../store/library";
import { Tip } from "../ui";

export const tokenLabel = (tokens: number | null | undefined) => tokens == null ? "число токенов неизвестно" : `${tokens.toLocaleString("ru-RU")} токенов`;

export function RefModBudget({ limits: supplied, showCreation = false }: { limits?: RefModLimits; showCreation?: boolean }) {
  const [loaded, setLoaded] = useState<RefModLimits>();
  const refs = useForm((s) => s.refs);
  const profileId = useForm((s) => s.profileId);
  const profiles = useLibrary((s) => s.profiles);
  useEffect(() => { if (!supplied) void api.refmodLimits().then(setLoaded).catch(() => undefined); }, [supplied]);
  const limits = supplied ?? loaded;
  const selected = refs.filter((r) => r.upload.refmod_file && (r.strength ?? 1) > 0);
  if (!showCreation && !selected.length) return null;
  const known = selected.reduce((sum, r) => sum + (r.upload.refmod_tokens ?? 0), 0);
  const unknown = selected.filter((r) => r.upload.refmod_tokens == null).length;
  const profile = profiles.find((p) => p.id === profileId) ?? profiles.find((p) => p.is_default);
  const pipeline = profile?.data.pipeline ?? "generate";
  const totalLimit = limits?.total_tokens[pipeline];
  return <div className="space-y-1 text-[11px] leading-relaxed text-muted" aria-label="Токены RefMods">
    {selected.length > 0 && <p className={totalLimit && known > totalLimit ? "text-warn" : undefined}>
      RefMods: {tokenLabel(known)}{unknown > 0 && ` + ${unknown} с неизвестным числом токенов`}.
    </p>}
    <Tip text="Это токены сохранённых референсов для H3, отдельно от текстового контекста ассистента. Сила RefMod до 100% не уменьшает число токенов. Обычные картинки, видео и промпт в эту сумму не входят.">
      <p>{limits ? totalLimit ? `Общий лимит RefMods при генерации: ${tokenLabel(totalLimit)}.` : "Общий лимит токенов RefMods не задан; доступный объём зависит от памяти и задачи." : "Лимит RefMods загружается…"}</p>
    </Tip>
    {showCreation && limits && <p>При создании: {limits.create_visual_tokens == null ? "лимит визуальных токенов не задан" : `до ${tokenLabel(limits.create_visual_tokens)} на один визуальный RefMod`}. Голос считается отдельно.</p>}
  </div>;
}
