import { tagOf } from "../../lib/refs";
import { useForm } from "../../store/form";
import { useUI } from "../../store/ui";
import { Dialog } from "../ui";
import { MediaRefEditor } from "./MediaRefEditor";
import { RefModEditor } from "./RefModEditor";

export function RefEditor() {
  const uid = useUI((s) => s.refEditor);
  const refs = useForm((s) => s.refs);
  const item = refs.find((r) => r.uid === uid);
  const close = () => useUI.getState().openRefEditor(null);
  return <Dialog open={!!item} onOpenChange={(o) => !o && close()} title={item ? `Изменить ${tagOf(refs, item.uid)}` : ""} wide>
    {item && (item.upload.refmod_file
      ? <RefModEditor key={item.uid} file={item.upload.refmod_file} onDone={close} />
      : <MediaRefEditor key={item.uid + item.upload.id} upload={item.upload}
          onApply={(upload) => useForm.getState().replaceRefUpload(item.uid, upload)} onDone={close} />)}
  </Dialog>;
}
