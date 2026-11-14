// 見本の拡張の画面。オーナーが社員に残すメモを 1 つ読み、置き換える (サービスと拡張の 3.8)
import { Alert, Button, Stack, TextField } from "knowidea-ui";
import { type FormEvent, useEffect, useState } from "react";
import type { ExtensionPageProps, ExtensionScreen } from "../../screen/extensions.ts";
import { SampleNote } from "./schema.ts";

/**
 * メモの画面
 * @param props 拡張の画面が受ける物
 * @returns メモの欄と置くボタン
 */
function NotesPage({ api }: ExtensionPageProps) {
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState<"read" | "write" | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void api.get("/note", SampleNote).then((note) => {
      if (!live) return;
      if (note) setBody(note.body);
      else setFailed("read");
    });
    return () => {
      live = false;
    };
  }, [api]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (body === null) return;
    setSaving(true);
    setSaved(false);
    const note = await api.put("/note", { body }, SampleNote);
    setSaving(false);
    setFailed(note ? null : "write");
    setSaved(note !== null);
  };

  if (failed === "read") return <Alert tone="error" title="メモを読めませんでした">時間をおいて開き直してください</Alert>;
  if (body === null) return <p>メモを読んでいます</p>;
  return (
    <form onSubmit={(e) => void save(e)}>
      <Stack gap={3}>
        <TextField label="メモ" hint="社員は note_read で読みます。2,000 字まで" multiline rows={6} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
        <div>
          <Button type="submit" loading={saving}>
            置く
          </Button>
        </div>
        {failed === "write" ? (
          <Alert tone="error" title="メモを置けませんでした" live>
            時間をおいて置き直してください
          </Alert>
        ) : null}
        {saved ? (
          <Alert tone="success" live>
            置きました
          </Alert>
        ) : null}
      </Stack>
    </form>
  );
}

/** メモの画面と切り替えの絵 */
export const screen: ExtensionScreen = { icon: "note", Page: NotesPage };
