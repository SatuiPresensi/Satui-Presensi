export async function onRequest(context) {
    const { request, env } = context;

    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json;charset=utf-8"
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    const SUPABASE_URL = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
    const SUPABASE_KEY = (env.SUPABASE_KEY || env.SUPABASE_ANON_KEY || "").trim();

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return new Response(JSON.stringify({
            status: "error",
            message: "Environment Variable SUPABASE_URL atau SUPABASE_KEY belum terbaca di Cloudflare!"
        }), { status: 500, headers: corsHeaders });
    }

    // Helper REST API Supabase (Ditingkatkan hingga 5.000 baris)
    async function sbFetch(endpoint, options = {}) {
        const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
        const headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Range-Unit": "items",
            "Range": "0-4999",
            ...(options.headers || {})
        };
        const res = await fetch(url, { ...options, headers });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Supabase Error (${res.status}): ${errText}`);
        }
        const text = await res.text();
        return text ? JSON.parse(text) : [];
    }

    // Helper Waktu WITA (GMT+8)
    function getWitaNow() {
        const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Makassar" }));
        const dd = String(now.getDate()).padStart(2, "0");
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const yyyy = now.getFullYear();
        const hh = String(now.getHours()).padStart(2, "0");
        const min = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");
        return {
            waktuFormatted: `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`,
            tanggalISO: `${yyyy}-${mm}-${dd}`,
            tanggalPrefix: `${dd}/${mm}/${yyyy}`,
            jamMenit: `${hh}:${min}`
        };
    }

    // Helper Konversi Waktu Baris Log (Anti-Null untuk Data Scanner)
    function formatWaktuLog(row) {
        if (row.waktu && String(row.waktu).trim() !== "") {
            const w = String(row.waktu).trim();
            // Jika formatnya YYYY-MM-DD HH:mm:ss, ubah ke DD/MM/YYYY HH:mm:ss
            const isoMatch = w.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}:\d{2}:\d{2})/);
            if (isoMatch) {
                return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]} ${isoMatch[4]}`;
            }
            return w;
        }
        if (row.created_at) {
            const d = new Date(new Date(row.created_at).toLocaleString("en-US", { timeZone: "Asia/Makassar" }));
            if (!isNaN(d.getTime())) {
                const dd = String(d.getDate()).padStart(2, "0");
                const mm = String(d.getMonth() + 1).padStart(2, "0");
                const yyyy = d.getFullYear();
                const hh = String(d.getHours()).padStart(2, "0");
                const min = String(d.getMinutes()).padStart(2, "0");
                const ss = String(d.getSeconds()).padStart(2, "0");
                return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
            }
        }
        if (row.tanggal) {
            const parts = String(row.tanggal).split("-");
            if (parts.length === 3) {
                return `${parts[2]}/${parts[1]}/${parts[0]} 07:00:00`;
            }
            return String(row.tanggal);
        }
        return getWitaNow().waktuFormatted;
    }

    try {
        let body = {};
        if (request.method === "POST") {
            try {
                body = await request.json();
            } catch (e) {
                body = {};
            }
        }
        const aksi = body.aksi || body.action || "get_data";

        // 1. AMBIL SEMUA DATA (MENGAMBIL DATA TERBARU TERLEBIH DAHULU AGAR TIDAK TERPOTONG LIMIT 1000)
        if (aksi === "get_data") {
            const [siswaData, guruData, absenDataDesc] = await Promise.all([
                sbFetch("siswa?select=nis,nama,kelas&order=kelas.asc,nama.asc"),
                sbFetch("guru?select=nip,nama,rfid&order=nama.asc"),
                sbFetch("log_absen?select=*&order=id.desc&limit=5000")
            ]);

            // Balik urutan agar dari terlama ke terbaru (sesuai pembacaan tabel & grafik di index.html)
            const absenData = (absenDataDesc || []).reverse();

            return new Response(JSON.stringify({
                status: "success",
                siswa: [["NIS", "Nama", "Kelas"], ...siswaData.map(s => [s.nis, s.nama, s.kelas])],
                guru: [["NIP", "Nama", "RFID"], ...guruData.map(g => [g.nip, g.nama, g.rfid || "-"])],
                absen: [["Waktu", "Nama", "NIS/NIP", "Kelas/Jabatan", "Status", "Tipe", "Pulang"], ...absenData.map(a => [
                    formatWaktuLog(a),
                    a.nama || "-",
                    a.nis_nip || a.nis || a.nip || "-",
                    a.kelas || a.kelas_jabatan || "-",
                    a.status || "Masuk",
                    a.tipe || (a.kelas === "Guru" ? "Guru" : "Siswa"),
                    a.pulang || ""
                ])]
            }), { headers: corsHeaders });
        }

        // 2. IMPORT SISWA
        if (aksi === "import_siswa") {
            const list = (body.siswaList || []).map(s => ({
                nis: String(s.nis || "").trim(),
                nama: String(s.nama || "").trim().toUpperCase(),
                kelas: String(s.kelas || "").trim()
            })).filter(s => s.nis && s.nama);

            if (list.length > 0) {
                await sbFetch("siswa?on_conflict=nis", {
                    method: "POST",
                    headers: { "Prefer": "resolution=merge-duplicates" },
                    body: JSON.stringify(list)
                });
            }
            return new Response(JSON.stringify({ status: "success", message: `${list.length} siswa berhasil disimpan ke Supabase.` }), { headers: corsHeaders });
        }

        // 3. IMPORT GURU
        if (aksi === "import_guru") {
            const list = (body.guruList || []).map(g => ({
                nip: String(g.nip || "").trim(),
                nama: String(g.nama || "").trim(),
                rfid: String(g.rfid || "-").trim() || "-"
            })).filter(g => g.nip && g.nama);

            if (list.length > 0) {
                await sbFetch("guru?on_conflict=nip", {
                    method: "POST",
                    headers: { "Prefer": "resolution=merge-duplicates" },
                    body: JSON.stringify(list)
                });
            }
            return new Response(JSON.stringify({ status: "success", message: `${list.length} guru berhasil disimpan ke Supabase.` }), { headers: corsHeaders });
        }

        // 4. ABSEN MANUAL & SCAN QR/RFID
        if (aksi === "absen_manual" || aksi === "scan" || aksi === "absen" || aksi === "catat_absen") {
            const wita = getWitaNow();
            const nis = String(body.nis || body.nis_nip || body.id || "").trim();
            let nama = String(body.nama || "").trim();
            const status = String(body.status || body.mode || "Masuk").trim();
            const timestamp = String(body.timestamp || body.waktu || wita.waktuFormatted).trim();
            const tglPrefix = timestamp.split(" ")[0];
            const jamPart = (timestamp.split(" ")[1] || wita.jamMenit).substring(0, 5);
            const [dd, mm, yyyy] = tglPrefix.split("/");
            const tanggalISO = (yyyy && mm && dd) ? `${yyyy}-${mm}-${dd}` : wita.tanggalISO;

            let kelas = body.kelas || "-", tipe = body.tipe || "Siswa";
            const s = await sbFetch(`siswa?nis=eq.${encodeURIComponent(nis)}&select=nama,kelas`);
            if (s.length > 0) {
                kelas = s[0].kelas;
                if (!nama) nama = s[0].nama;
            } else {
                const g = await sbFetch(`guru?or=(nip.eq.${encodeURIComponent(nis)},rfid.eq.${encodeURIComponent(nis)})&select=nip,nama`);
                if (g.length > 0) {
                    kelas = "Guru";
                    tipe = "Guru";
                    if (!nama) nama = g[0].nama;
                }
            }

            const existing = await sbFetch(
                `log_absen?nis_nip=eq.${encodeURIComponent(nis)}&or=(waktu.like.${encodeURIComponent(tglPrefix)}*,tanggal.eq.${encodeURIComponent(tanggalISO)})&select=*&order=id.desc&limit=1`
            );

            if (status === "Pulang") {
                if (existing.length > 0) {
                    await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ pulang: `Pulang (${jamPart})` })
                    });
                } else {
                    await sbFetch("log_absen", {
                        method: "POST",
                        body: JSON.stringify({
                            waktu: timestamp, tanggal: tanggalISO, nama, nis_nip: nis, kelas, status: "Masuk", tipe, pulang: `Pulang (${jamPart})`
                        })
                    });
                }
                return new Response(JSON.stringify({ status: "success", message: `Status Pulang (${jamPart}) untuk ${nama} berhasil disimpan!` }), { headers: corsHeaders });
            }

            if (status === "Reset_Pulang") {
                if (existing.length > 0) {
                    await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ pulang: "" })
                    });
                }
                return new Response(JSON.stringify({ status: "success", message: `Status Pulang untuk ${nama} berhasil di-reset!` }), { headers: corsHeaders });
            }

            if (existing.length > 0) {
                await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ waktu: timestamp, status: status })
                });
            } else {
                await sbFetch("log_absen", {
                    method: "POST",
                    body: JSON.stringify({
                        waktu: timestamp, tanggal: tanggalISO, nama, nis_nip: nis, kelas, status: status, tipe, pulang: ""
                    })
                });
            }

            return new Response(JSON.stringify({ status: "success", message: `Presensi ${status} untuk ${nama} berhasil disimpan!` }), { headers: corsHeaders });
        }

        // 5. AKSI HAPUS DATA SISWA & GURU
        if (aksi === "hapus_siswa") {
            const nis = String(body.nis || "").trim();
            if (nis) await sbFetch(`siswa?nis=eq.${encodeURIComponent(nis)}`, { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }

        if (aksi === "hapus_kelas_siswa") {
            const kelas = String(body.kelas || "").trim();
            if (kelas) await sbFetch(`siswa?kelas=eq.${encodeURIComponent(kelas)}`, { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }

        if (aksi === "hapus_semua_siswa") {
            await sbFetch("siswa?nis=neq.___KOSONG___", { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }

        if (aksi === "hapus_guru") {
            const nip = String(body.nip || "").trim();
            if (nip) await sbFetch(`guru?nip=eq.${encodeURIComponent(nip)}`, { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }

        if (aksi === "hapus_semua_guru") {
            await sbFetch("guru?nip=neq.___KOSONG___", { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }

        // 6. RESTORE & HAPUS SEMUA DATABASE
        if (aksi === "hapus_semua_data") {
            await Promise.all([
                sbFetch("siswa?nis=neq.___KOSONG___", { method: "DELETE" }),
                sbFetch("guru?nip=neq.___KOSONG___", { method: "DELETE" }),
                sbFetch("log_absen?id=gt.0", { method: "DELETE" })
            ]);
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }

        if (aksi === "restore_all") {
            if (body.mode === "replace") {
                await Promise.all([
                    sbFetch("siswa?nis=neq.___KOSONG___", { method: "DELETE" }),
                    sbFetch("guru?nip=neq.___KOSONG___", { method: "DELETE" }),
                    sbFetch("log_absen?id=gt.0", { method: "DELETE" })
                ]);
            }
            const siswaRows = (body.siswa || []).slice(1).filter(r => r && r[0]).map(r => ({
                nis: String(r[0]).trim(), nama: String(r[1] || "").trim(), kelas: String(r[2] || "-").trim()
            }));
            const guruRows = (body.guru || []).slice(1).filter(r => r && r[0]).map(r => ({
                nip: String(r[0]).trim(), nama: String(r[1] || "").trim(), rfid: String(r[2] || "-").trim()
            }));
            const absenRows = (body.absen || []).slice(1).filter(r => r && r[0]).map(r => ({
                waktu: String(r[0]).trim(), nama: String(r[1] || "").trim(), nis_nip: String(r[2] || "").trim(),
                kelas: String(r[3] || "-").trim(), status: String(r[4] || "Masuk").trim(), tipe: String(r[5] || "Siswa").trim(), pulang: String(r[6] || "").trim()
            }));

            if (siswaRows.length > 0) {
                await sbFetch("siswa?on_conflict=nis", { method: "POST", headers: { "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify(siswaRows) });
            }
            if (guruRows.length > 0) {
                await sbFetch("guru?on_conflict=nip", { method: "POST", headers: { "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify(guruRows) });
            }
            if (absenRows.length > 0) {
                await sbFetch("log_absen", { method: "POST", body: JSON.stringify(absenRows) });
            }
            return new Response(JSON.stringify({ status: "success", message: "Restore ke Supabase selesai!" }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ status: "error", message: `Aksi '${aksi}' tidak dikenali.` }), { headers: corsHeaders });

    } catch (err) {
        return new Response(JSON.stringify({ status: "error", message: err.message }), { status: 500, headers: corsHeaders });
    }
}
