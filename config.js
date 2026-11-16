// Fill these in from Supabase: Project Settings → API.
// The "anon public" key is safe to publish: the database rules in supabase/schema.sql decide what it can do.
window.TREEHOLE_CONFIG = {
  supabaseUrl: "https://woeoxsprjmewqfrzmwtv.supabase.co",      // e.g. https://abcdxyz.supabase.co
  supabaseAnonKey: "sb_publishable_ds5jDrp5-6DCKGeRvs22nA_wwfIzlX6",
  // Set to true after setting up custom SMTP and adding {{ .Token }} to the Magic Link email template.
  emailCode: false,
};
