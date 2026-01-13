
import { qhareManager } from '../server/qhare_manager.js';
import fetch from 'node-fetch';
import { URLSearchParams } from 'url';

async function testUrlEncodedList() {
    console.log("🕵️ ULTIME ESSAI: POST /lead/list en x-www-form-urlencoded");

    const params = new URLSearchParams();
    params.append('access_token', qhareManager.apiKey);
    params.append('limit', '5');
    params.append('page', '1');

    try {
        const url = `${qhareManager.baseUrl}/lead/list`;
        console.log(`📡 POST ${url}`);

        const res = await fetch(url, {
            method: 'POST',
            body: params
        });

        console.log(`Status: ${res.status}`);
        const text = await res.text();
        console.log("Response:", text.substring(0, 500));

    } catch (e) {
        console.error("Error:", e);
    }
}

testUrlEncodedList();
