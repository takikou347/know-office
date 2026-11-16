// 職務経歴の拡張の画面。開くとパスキーで確かめてから中身を出し、置き換えと、人に見せる項目の書き出しをする (サービスと拡張の 3.8)
import { Alert, Button, Checkbox, Stack, TextField } from "knowidea-ui";
import { type FormEvent, useEffect, useState } from "react";
import type { ExtensionApi, ExtensionPageProps, ExtensionScreen } from "../../screen/extensions.ts";
import { CAREER_FIELD_LABEL, CAREER_FIELDS, type CareerField, CareerProfile, CareerShowcase } from "./schema.ts";

/** 欄の字数の上限 */
const MAX_CHARS = 4000;

export interface ShowcaseFormProps {
  /** 職務経歴のルートを呼ぶ口 */
  api: ExtensionApi;
}

/**
 * 人に見せる項目を選んで書き出す欄。書き出した項目と値を下に出す
 * @param props 呼ぶ口
 * @returns 選ぶ欄と書き出すボタン
 */
function ShowcaseForm({ api }: ShowcaseFormProps) {
  const [fields, setFields] = useState<readonly CareerField[]>([]);
  const [shown, setShown] = useState<CareerShowcase | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void api.get("/showcase", CareerShowcase).then((current) => {
      if (!live) return;
      // 選ぶ欄は前に書き出した物を読み終えてから出す。読む前に選ぶと、読んだ値で選んだ物を上書きしてしまう
      setLoaded(true);
      if (!current) return;
      setShown(current);
      setFields(CAREER_FIELDS.filter((f) => f in current.items));
    });
    return () => {
      live = false;
    };
  }, [api]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    const result = await api.put("/showcase", { fields }, CareerShowcase);
    setSending(false);
    setFailed(result === null);
    if (result) setShown(result);
  };

  if (!loaded) return <p role="status">書き出した物を読んでいます</p>;
  return (
    <form onSubmit={(e) => void send(e)} aria-label="人に見せる項目">
      <Stack gap={3}>
        <p>選んだ項目だけを書き出します。見せるサービスの社員は書き出した物だけを読み、ほかの項目は know-office の外に出ません。</p>
        {CAREER_FIELDS.map((f) => (
          <Checkbox key={f} label={CAREER_FIELD_LABEL[f]} checked={fields.includes(f)} onCheckedChange={(on) => setFields(CAREER_FIELDS.filter((x) => (x === f ? on : fields.includes(x))))} />
        ))}
        <div>
          <Button type="submit" variant="secondary" loading={sending}>
            書き出す
          </Button>
        </div>
        {failed ? (
          <Alert tone="error" title="書き出せませんでした" live>
            時間をおいて書き出し直してください
          </Alert>
        ) : null}
        {shown ? (
          <section aria-label="書き出した物">
            {Object.keys(shown.items).length === 0 ? (
              <p>まだ何も書き出していません</p>
            ) : (
              <dl>
                {CAREER_FIELDS.filter((f) => f in shown.items).map((f) => (
                  <div key={f}>
                    <dt>{CAREER_FIELD_LABEL[f]}</dt>
                    <dd>{shown.items[f]}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        ) : null}
      </Stack>
    </form>
  );
}

/**
 * 職務経歴の画面。開く時にパスキーで確かめる
 * @param props 拡張の画面が受ける物
 * @returns 職務経歴の欄と置くボタン
 */
function CareerPage({ api }: ExtensionPageProps) {
  const [profile, setProfile] = useState<CareerProfile | null>(null);
  const [failed, setFailed] = useState<"read" | "write" | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void api.get("/profile", CareerProfile).then((read) => {
      if (!live) return;
      if (read) setProfile(read);
      else setFailed("read");
    });
    return () => {
      live = false;
    };
  }, [api]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (profile === null) return;
    setSaving(true);
    setSaved(false);
    const written = await api.put("/profile", profile, CareerProfile);
    setSaving(false);
    setFailed(written ? null : "write");
    setSaved(written !== null);
  };

  if (failed === "read") return <Alert tone="error" title="職務経歴を開けませんでした">パスキーで確かめてから開き直してください</Alert>;
  if (profile === null) return <p role="status">パスキーで確かめてから職務経歴を開きます</p>;
  return (
    <Stack gap={4}>
      <form onSubmit={(e) => void save(e)} aria-label="職務経歴">
        <Stack gap={3}>
          {CAREER_FIELDS.map((f) => (
            <TextField
              key={f}
              label={CAREER_FIELD_LABEL[f]}
              hint={`項目ごとに暗号にして置きます。${MAX_CHARS.toLocaleString("ja-JP")} 字まで`}
              multiline
              rows={4}
              maxLength={MAX_CHARS}
              value={profile[f]}
              onChange={(e) => setProfile({ ...profile, [f]: e.target.value })}
            />
          ))}
          <div>
            <Button type="submit" loading={saving}>
              置く
            </Button>
          </div>
          {failed === "write" ? (
            <Alert tone="error" title="職務経歴を置けませんでした" live>
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
      <ShowcaseForm api={api} />
    </Stack>
  );
}

/** 職務経歴の画面と切り替えの絵 */
export const screen: ExtensionScreen = { icon: "user", Page: CareerPage };
