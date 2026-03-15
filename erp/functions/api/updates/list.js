
export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, packages: [] }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
