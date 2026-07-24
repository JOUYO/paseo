import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { readCursorTokenFromAuthJson } from "./cursor.js";

describe("readCursorTokenFromAuthJson", () => {
  test("reads accessToken from cursor-agent auth.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cursor-auth-"));
    await mkdir(join(home, ".config", "cursor"), { recursive: true });
    await writeFile(
      join(home, ".config", "cursor", "auth.json"),
      JSON.stringify({ accessToken: "cursor_cli_token", refreshToken: "refresh" }),
    );

    await expect(readCursorTokenFromAuthJson(home)).resolves.toBe("cursor_cli_token");
  });

  test("returns null when auth.json is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cursor-auth-missing-"));
    await expect(readCursorTokenFromAuthJson(home)).resolves.toBeNull();
  });

  test("returns null when accessToken is empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cursor-auth-empty-"));
    await mkdir(join(home, ".config", "cursor"), { recursive: true });
    await writeFile(
      join(home, ".config", "cursor", "auth.json"),
      JSON.stringify({ accessToken: "" }),
    );

    await expect(readCursorTokenFromAuthJson(home)).resolves.toBeNull();
  });
});
