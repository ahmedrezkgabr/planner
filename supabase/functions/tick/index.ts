// tick: called every minute by pg_cron (supabase/local/cron.sql). Sends the block reminders that are due as Web Push.
// Rules match the old in-app ones: fire once at start − lead; if we're more than 5 min late, stay silent (no stale alerts).
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET. SUPABASE_DB_URL is provided by Supabase.
import webpush from 'npm:web-push@3.6.7';
import postgres from 'npm:postgres@3.4.5';

const env = (k: string) => Deno.env.get(k) ?? '';
const sql = postgres(env('SUPABASE_DB_URL'), { prepare: false, max: 2 });
webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));

Deno.serve(async (req) => {
  if (!env('CRON_SECRET') || req.headers.get('x-cron-secret') !== env('CRON_SECRET')) return new Response('forbidden', { status: 403 });

  // Claim first (sent_at), then send: a crash or an overlapping run can't send twice.
  const due = await sql`
    update occurrences set sent_at = now()
    where sent_at is null and not deleted and remind_at <= now() and remind_at > now() - interval '5 minutes'
    returning id, user_id, name, body, color, start_at`;
  if (!due.length) return Response.json({ due: 0 });

  const subs = await sql`select endpoint, user_id, p256dh, auth from push_subs where user_id in ${sql([...new Set(due.map((d) => d.user_id))])}`;
  let sent = 0;
  const gone: string[] = [];
  await Promise.all(due.flatMap((d) => subs.filter((s) => s.user_id === d.user_id).map(async (s) => {
    const msLeft = new Date(d.start_at).getTime() - Date.now(), mins = Math.round(msLeft / 60000);
    const name = String(d.name).split(/[:,]/)[0];
    const payload = JSON.stringify({ title: mins > 0 ? `${name} starts in ${mins} min` : `${name} starts now`, body: d.body, color: d.color, tag: d.id });
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
        { TTL: Math.max(60, Math.round(msLeft / 1000)), urgency: 'high' });   // undelivered after the block starts = useless
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint);               // device unsubscribed or reinstalled
      else console.error('push failed', code, (e as { body?: string }).body ?? String(e));
    }
  })));
  if (gone.length) await sql`delete from push_subs where endpoint in ${sql(gone)}`;
  return Response.json({ due: due.length, sent, gone: gone.length });
});
