// /admin/*：bootstrap 与手动同步。Bearer ADMIN_TOKEN，常量时间比较。

import { timingSafeEqualString } from "../sync/crypto";
import type { SeedInput } from "../sync/coordinator";
import { errorResponse, jsonResponse } from "./headers";

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const expected = env.ADMIN_TOKEN ?? "";
  if (!expected || !token) return false;
  return timingSafeEqualString(token, expected);
}

export async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  if (!authorized(request, env)) {
    return errorResponse(401, "admin token required", "unauthorized");
  }
  const stub = env.SYNC.getByName("primary");

  if (path === "/admin/status" && request.method === "GET") {
    return jsonResponse(await stub.status());
  }
  if (path === "/admin/sync" && request.method === "POST") {
    return jsonResponse(await stub.runSync("manual"));
  }
  if (path === "/admin/seed" && request.method === "POST") {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_ADMIN_BODY_BYTES) return errorResponse(413, "body too large", "too_large");
    let body: SeedInput;
    try {
      body = (await request.json()) as SeedInput;
    } catch {
      return errorResponse(400, "body must be JSON", "bad_request");
    }
    try {
      return jsonResponse(await stub.seed(body));
    } catch (error) {
      return errorResponse(400, String(error instanceof Error ? error.message : error), "bad_request");
    }
  }
  return errorResponse(404, "not found", "not_found");
}
