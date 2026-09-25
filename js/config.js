/* Supabase project settings (SPEC §13). Leave empty for local-only mode.
   The publishable key is public by design: row-level security keeps each user's data private. */
const SUPABASE_URL = 'https://tohbcduymsuaqivuabei.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_hzUba_dNWr2LhhKD58derg_oUz7PPbk';
// Web Push (VAPID) public key. Its private half is a Supabase secret, never in this repo.
const VAPID_PUBLIC_KEY = 'BENKCigcgudSJ1hiZ6CyT4E-LI0X3P7I2qXhWupI3NRQcVon-ud9r4enLdRgeZa8k_CiqH3kjBxhcTi_9O-GrA0';
