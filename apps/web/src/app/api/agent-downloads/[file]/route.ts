import fs from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { getDownloadManifest, getDownloadsBaseUrl } from "@/lib/downloads/manifest";
import { DownloadNotAllowedError, resolveAgentFilePath, resolveManifestFile } from "@/lib/downloads/resolveDownload";

/**
 * Dev-only package serving. When `AGENT_DOWNLOADS_BASE_URL` is set
 * (production), this route is unreachable for real — nginx serves the
 * files directly (see deploy/nginx/nginx.conf, DEPLOYMENT.md) and the
 * downloads page links straight there. Here, every request must name a
 * file listed in apps/agent/packaging/manifest.json; anything else
 * (unknown name, a traversal attempt) is refused with 404 before touching
 * the filesystem for real.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  if (getDownloadsBaseUrl()) {
    return NextResponse.json({ error: "not available in this environment" }, { status: 404 });
  }

  const { file } = await params;

  let manifest;
  try {
    manifest = await getDownloadManifest();
  } catch {
    return NextResponse.json({ error: "no agent packages built yet" }, { status: 404 });
  }

  try {
    const entry = resolveManifestFile(manifest, file);
    const filePath = resolveAgentFilePath(entry);
    const data = await fs.readFile(filePath);
    return new NextResponse(data, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${entry.name}"`,
        "Content-Length": String(entry.size),
      },
    });
  } catch (err) {
    if (err instanceof DownloadNotAllowedError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
