// v1.yaml がコードのルートとスキーマから作った文書と同じ事、OpenAPI 3.1 として正しい事を確かめる。API の決まりの 3.5
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { openApiDocument } from "../../src/gate/api-doc.ts";

const JsonValue = z.json() as z.ZodType<Json>;

const text = readFileSync(join(import.meta.dirname, "../../openapi/v1.yaml"), "utf8");
const v1 = JsonValue.parse(parse(text));
const generated = JsonValue.parse(JSON.parse(JSON.stringify(openApiDocument())));

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/**
 * JSON のオブジェクトかを確かめる
 * @param value JSON の値
 * @returns 配列でないオブジェクトなら true
 */
function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 意味の変わらない書き方の違いをそろえる。パラメーターは場所と名前の順に並べ、スキーマと同じ説明をパラメーターに重ねた物は外し、空のスキーマの additionalProperties は true にする
 * @param root 文書
 * @returns そろえた文書
 */
function canonical(root: Json): Json {
  const components = isObject(root) ? root["components"] : undefined;
  const schemas = isObject(components) && isObject(components["schemas"]) ? components["schemas"] : {};
  const schemaOf = (param: JsonObject): Json | undefined => {
    const schema = param["schema"];
    const ref = isObject(schema) && typeof schema["$ref"] === "string" ? schema["$ref"].split("/").at(-1) : undefined;
    return ref === undefined ? schema : schemas[ref];
  };
  const param = (p: Json): Json => {
    if (!isObject(p)) return p;
    const { description, ...rest } = p;
    const schema = schemaOf(rest);
    return walk(description === undefined || (isObject(schema) && schema["description"] === description) ? rest : { ...rest, description });
  };
  const order = (p: Json) => (isObject(p) ? JSON.stringify(p["$ref"] ?? [p["in"], p["name"]]) : "");
  const walk = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, v]): [string, Json] => {
        if (key === "additionalProperties" && isObject(v) && Object.keys(v).length === 0) return [key, true];
        if (key !== "parameters") return [key, walk(v)];
        // components/parameters は名前ごとの表、操作の parameters は並び
        if (Array.isArray(v)) return [key, v.map(param).toSorted((a, b) => order(a).localeCompare(order(b)))];
        return [key, isObject(v) ? Object.fromEntries(Object.entries(v).map(([name, p]) => [name, param(p)])) : v];
      }),
    );
  };
  return walk(root);
}

describe("OpenAPI の文書", () => {
  it("コードから作った文書は、今の v1.yaml と意味で同じ", () => {
    expect(canonical(generated)).toEqual(canonical(v1));
  });
});
