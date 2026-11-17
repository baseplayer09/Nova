import { createClient } from '@supabase/supabase-js';

export class AccountDeletionError extends Error {
  constructor(
    readonly reason: 'not_configured' | 'invalid_credentials' | 'delete_failed',
  ) {
    super(reason);
    this.name = 'AccountDeletionError';
  }
}

export function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export async function getAuthenticatedUserFromRequest(
  authorizationHeader: string | undefined,
) {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    return null;
  }

  const client = getSupabaseClient();
  if (!client) {
    return null;
  }

  const token = authorizationHeader.replace(/^Bearer\s+/i, '').trim();
  const { data, error } = await client.auth.getUser(token);

  if (error || !data.user) {
    return null;
  }

  return data.user;
}

export async function deleteSupabaseAccount(
  userId: string,
  email: string,
  password: string,
): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    throw new AccountDeletionError('not_configured');
  }

  const authOptions = {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  };
  const verificationClient = createClient(supabaseUrl, supabaseAnonKey, authOptions);
  const { data, error } = await verificationClient.auth.signInWithPassword({
    email,
    password,
  });
  if (error || data.user?.id !== userId) {
    throw new AccountDeletionError('invalid_credentials');
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, authOptions);
  const deletion = await adminClient.auth.admin.deleteUser(userId);
  if (deletion.error) {
    throw new AccountDeletionError('delete_failed');
  }
}
