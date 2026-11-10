import type { Health } from "@know-office/core";

export function App({ health }: { health?: Health }) {
  return (
    <main>
      <h1>know-office</h1>
      <p>{health ? "入口とつながりました" : "入口を確かめています"}</p>
    </main>
  );
}
