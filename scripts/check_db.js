
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    const { data, error, count } = await supabase
        .from('clients')
        .select('*', { count: 'exact', head: true });

    console.log("Count:", count);
    console.log("Error:", error);

    // Check first 5 rows
    const { data: rows } = await supabase.from('clients').select('id, nom').limit(5);
    console.log("First 5 rows:", rows);
}

check();
