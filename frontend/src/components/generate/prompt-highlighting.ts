import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** Decorations leave the plain-text prompt and the editor's undo history intact. */
export const PromptHighlighting = Extension.create({
  name: "promptHighlighting",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("promptHighlighting"),
      props: {
        decorations(state) {
          const marks: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return;
            const patterns: [RegExp, string][] = [
              [/^(?:subject_definitions|summary|retention_analysis|detailed_description|visual_style|overall_soundscape|non_diegetic_music)\s*:/gim, "prompt-section"],
              [/\[Shot\s+\d+\](?:\s*at\s+\d+:\d{2}\.\d{3})?/gi, "prompt-shot"],
              [/<Subject\s+\d+>|\(S\d+(?:,\s*S\d+)*\)/gi, "prompt-subject"],
              [/<d>[\s\S]*?<\/d>/gi, "prompt-dialogue"],
            ];
            for (const [pattern, className] of patterns) {
              for (const m of node.text.matchAll(pattern)) marks.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: className }));
            }
          });
          return DecorationSet.create(state.doc, marks);
        },
      },
    })];
  },
});
