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

    // Helper REST API Supabase (Maks 5.000 baris)
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
            dateObj: now,
            dayOfWeek: now.getDay(), // 0: Minggu, 1-4: Sen-Kam, 5: Jumat, 6: Sabtu
            totalMinutes: now.getHours() * 60 + now.getMinutes(),
            waktuFormatted: `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`,
            tanggalISO: `${yyyy}-${mm}-${dd}`,
            tanggalPrefix: `${dd}/${mm}/${yyyy}`,
            jamMenit: `${hh}:${min}`
        };
    }

    // Helper Konversi Waktu Baris Log
    function formatWaktuLog(row) {
        if (row.waktu && String(row.waktu).trim() !== "") {
            const w = String(row.waktu).trim();
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

        // 1. AMBIL SEMUA DATA
        if (aksi === "get_data") {
            const [siswaData, guruData, absenDataDesc] = await Promise.all([
                sbFetch("siswa?select=nis,nama,kelas&order=kelas.asc,nama.asc"),
                sbFetch("guru?select=nip,nama,rfid&order=nama.asc"),
                sbFetch("log_absen?select=*&order=id.desc&limit=5000")
            ]);

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

        // 4. ABSEN MANUAL & SCAN QR/RFID (DENGAN LOGIKA TERLAMBAT & JAM PULANG)
        if (aksi === "absen_manual" || aksi === "scan" || aksi === "absen" || aksi === "catat_absen") {
            const wita = getWitaNow();
            const isManualAdmin = (aksi === "absen_manual");
            const nis = String(body.nis || body.nis_nip || body.id || "").trim();
            let nama = String(body.nama || "").trim();
            let reqStatus = String(body.status || body.mode || "").trim();

            const timestamp = String(body.timestamp || body.waktu || wita.waktuFormatted).trim();
            const tglPrefix = timestamp.split(" ")[0];
            const jamPart = (timestamp.split(" ")[1] || wita.jamMenit).substring(0, 5);
            const [dd, mm, yyyy] = tglPrefix.split("/");
            const tanggalISO = (yyyy && mm && dd) ? `${yyyy}-${mm}-${dd}` : wita.tanggalISO;

            // Hitung menit waktu pencatatan & hari dalam minggu
            const [jamH, jamM] = jamPart.split(":").map(n => parseInt(n, 10) || 0);
            const scanMinutes = jamH * 60 + jamM;
            const targetDateObj = (yyyy && mm && dd) ? new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10)) : wita.dateObj;
            const dayOfWeek = targetDateObj.getDay(); // 0: Minggu, 1-4: Sen-Kam, 5: Jumat, 6: Sabtu

            // Aturan Batas Jam Masuk (07:25 WITA = 445 menit)
            const BATAS_MASUK_MENIT = 7 * 60 + 25;

            // Aturan Batas Jam Pulang: Jumat 11:00 (660), Senin-Kamis 14:30 (870), Sabtu 12:00 (720)
            let batasPulangMenit = 14 * 60 + 30;
            let labelJamPulang = "14:30";
            if (dayOfWeek === 5) {
                batasPulangMenit = 11 * 60;
                labelJamPulang = "11:00";
            } else if (dayOfWeek === 6) {
                batasPulangMenit = 12 * 60;
                labelJamPulang = "12:00";
            }

            // Cari Data Peserta (Siswa / Guru)
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

            // Cek apakah sudah ada catatan absen pada tanggal tersebut
            const existing = await sbFetch(
                `log_absen?nis_nip=eq.${encodeURIComponent(nis)}&or=(waktu.like.${encodeURIComponent(tglPrefix)}*,tanggal.eq.${encodeURIComponent(tanggalISO)})&select=*&order=id.desc&limit=1`
            );

            // A. JIKA AKSI RESET PULANG DARI ADMIN
            if (reqStatus === "Reset_Pulang") {
                if (existing.length > 0) {
                    await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ pulang: "" })
                    });
                }
                return new Response(JSON.stringify({ status: "success", message: `Status Pulang untuk ${nama} berhasil di-reset!` }), { headers: corsHeaders });
            }

            // B. JIKA AKSI IZIN ATAU SAKIT
            if (reqStatus === "Izin" || reqStatus === "Sakit") {
                if (existing.length > 0) {
                    await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ waktu: timestamp, status: reqStatus })
                    });
                } else {
                    await sbFetch("log_absen", {
                        method: "POST",
                        body: JSON.stringify({
                            waktu: timestamp, tanggal: tanggalISO, nama, nis_nip: nis, kelas, status: reqStatus, tipe, pulang: ""
                        })
                    });
                }
                return new Response(JSON.stringify({ status: "success", message: `Presensi ${reqStatus} untuk ${nama} berhasil disimpan!` }), { headers: corsHeaders });
            }

            // C. PENENTUAN OTOMATIS MASUK vs PULANG & PROTEKSI JAM PULANG
            let isPulangAction = (reqStatus === "Pulang");
            if (!isManualAdmin && existing.length > 0 && (!reqStatus || reqStatus === "Masuk")) {
                // Jika sudah absen masuk hari ini dan melakukan scan kedua kali di alat scanner
                isPulangAction = true;
            }

            if (isPulangAction) {
                // Proteksi jam pulang (hanya berlaku untuk scan non-admin atau jika belum waktunya pulang)
                if (!isManualAdmin && scanMinutes < batasPulangMenit) {
                    return new Response(JSON.stringify({
                        status: "warning",
                        message: `Halo ${nama}, Anda sudah tercatat hadir hari ini. Scan Pulang baru dibuka pukul ${labelJamPulang} WITA.`
                    }), { headers: corsHeaders });
                }

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

            // D. PENCATATAN KEHADIRAN MASUK & DETEKSI TERLAMBAT (> 07:25 WITA)
            let finalStatusMasuk = "Masuk";
            if (scanMinutes > BATAS_MASUK_MENIT) {
                const selisihMenit = scanMinutes - BATAS_MASUK_MENIT;
                finalStatusMasuk = `Terlambat (+${selisihMenit} mnt)`;
            }

            if (existing.length > 0) {
                await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ waktu: timestamp, status: finalStatusMasuk })
                });
            } else {
                await sbFetch("log_absen", {
                    method: "POST",
                    body: JSON.stringify({
                        waktu: timestamp, tanggal: tanggalISO, nama, nis_nip: nis, kelas, status: finalStatusMasuk, tipe, pulang: ""
                    })
                });
            }

            return new Response(JSON.stringify({ status: "success", message: `Presensi ${finalStatusMasuk} untuk ${nama} berhasil disimpan!` }), { headers: corsHeaders });
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
