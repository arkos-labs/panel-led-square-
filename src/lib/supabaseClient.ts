import { createClient } from '@supabase/supabase-js';

// VALEURS EN DUR POUR DEBLOQUER VERCEL (Fix Page Blanche EXTREME)
// On retire complètement import.meta.env pour que le compilateur ne cherche rien
const supabaseUrl = "https://hldxvcwowkltwznumqsd.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhsZHh2Y3dvd2tsdHd6bnVtcXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzU4MzU0NjUsImV4cCI6MjA1MTQxMTQ2NX0.v1o_1Lg9sM0tK4_4y3_2w5y6u7v8x9z0A1B2C3D4E5";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
