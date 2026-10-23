// Replace the live bootstrap entrypoint with this after the owner link is saved.
Deno.serve(() => new Response(JSON.stringify({ error: 'Setup is closed.' }), {
  status: 410,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
}));
