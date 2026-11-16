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

    const SUPABASE_URL = (env.SUPABASE_URL || "").replace(/\/\$/, "");
    const SUPABASE_KEY = env.SUPABASE_KEY || env.SUPABASE_ANON_KEY || "";

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return new Response(JSON.stringify({
            status: "error",
            message: "Environment Variable SUPABASE_URL dan SUPABASE_KEY belum diatur di Cloudflare!"
        }), { status: 500, headers: corsHeaders });
    }

    // Helper REST API Supabase
    async function sbFetch(endpoint, options = {}) {
        const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
        const headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
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

    // Helper Ekstrak NIS/NIP dari teks QR Multiline
    function ekstrakKodeScan(rawInput) {
        if (!rawInput) return "";
        const str = String(rawInput).trim();
        const matchID = str.match(/(?:NIS|NIP|ID)\s*:\s*([^\n\r]+)/i);
        if (matchID) return matchID[1].trim();
        return str.split(/[\n\r]/)[0].trim();
    }

    try {
        const body = request.method === "POST" ? await request.json() : {};
        const aksi = body.aksi || body.action || "get_data";

        // =====================================================================
        // 1. AMBIL SEMUA DATA (UNTUK DASHBOARD ADMIN & SCANNER)
        // =====================================================================
        if (aksi === "get_data") {
            const [siswaData, guruData, absenData] = await Promise.all([
                sbFetch("siswa?select=nis,nama,kelas&order=kelas.asc,nama.asc"),
                sbFetch("guru?select=nip,nama,rfid&order=nama.asc"),
                sbFetch("log_absen?select=id,waktu,nama,nis_nip,kelas,status,tipe,pulang&order=id.asc")
            ]);

            return new Response(JSON.stringify({
                status: "success",
                siswa: [["NIS", "Nama", "Kelas"], ...siswaData.map(s => [s.nis, s.nama, s.kelas])],
                guru: [["NIP", "Nama", "RFID"], ...guruData.map(g => [g.nip, g.nama, g.rfid || "-"])],
                absen: [["Waktu", "Nama", "NIS/NIP", "Kelas/Jabatan", "Status", "Tipe", "Pulang"], ...absenData.map(a => [
                    a.waktu, a.nama, a.nis_nip, a.kelas, a.status || "Masuk", a.tipe || "Siswa", a.pulang || ""
                ])]
            }), { headers: corsHeaders });
        }

        // =====================================================================
        // 2. PROSES SCAN QR CODE / RFID (DARI HALAMAN SCANNER)
        // =====================================================================
        if (aksi === "scan" || aksi === "absen" || aksi === "scan_qr" || aksi === "presensi") {
            const rawCode = body.qr || body.qr_data || body.kode || body.nis || body.id || body.rfid || "";
            const cleanID = ekstrakKodeScan(rawCode);
            if (!cleanID) {
                return new Response(JSON.stringify({ status: "error", message: "Kode QR / ID kosong!" }), { headers: corsHeaders });
            }

            // Cari di tabel siswa ( berdasarkan NIS )
            let peserta = null;
            const cekSiswa = await sbFetch(`siswa?nis=eq.${encodeURIComponent(cleanID)}&select=nis,nama,kelas`);
            if (cekSiswa.length > 0) {
                peserta = { id: cekSiswa[0].nis, nama: cekSiswa[0].nama, kelas: cekSiswa[0].kelas, tipe: "Siswa" };
            } else {
                // Cari di tabel guru ( berdasarkan NIP atau UID RFID )
                const cekGuru = await sbFetch(`guru?or=(nip.eq.${encodeURIComponent(cleanID)},rfid.eq.${encodeURIComponent(cleanID)})&select=nip,nama`);
                if (cekGuru.length > 0) {
                    peserta = { id: cekGuru[0].nip, nama: cekGuru[0].nama, kelas: "Guru", tipe: "Guru" };
                }
            }

            if (!peserta) {
                return new Response(JSON.stringify({
                    status: "error",
                    message: `Data dengan ID "${cleanID}" tidak ditemukan di database Siswa maupun Guru!`
                }), { headers: corsHeaders });
            }

            const wita = getWitaNow();
            const modeScan = (body.mode || body.status || "auto").toString().toLowerCase();

            // Cek apakah peserta sudah scan pada hari ini
            const logHariIni = await sbFetch(
                `log_absen?nis_nip=eq.${encodeURIComponent(peserta.id)}&waktu=like.${encodeURIComponent(wita.tanggalPrefix)}*&select=*&order=id.desc&limit=1`
            );

            if (logHariIni.length === 0) {
                // Belum absen hari ini -> Catat Masuk Baru
                const statusAwal = modeScan === "pulang" ? "Masuk" : "Masuk";
                const kolomPulang = modeScan === "pulang" ? `Pulang (${wita.jamMenit})` : "";

                await sbFetch("log_absen", {
                    method: "POST",
                    body: JSON.stringify({
                        waktu: wita.waktuFormatted,
                        tanggal: wita.tanggalISO,
                        nama: peserta.nama,
                        nis_nip: peserta.id,
                        kelas: peserta.kelas,
                        status: statusAwal,
                        tipe: peserta.tipe,
                        pulang: kolomPulang
                    })
                });

                return new Response(JSON.stringify({
                    status: "success",
                    tipe_absen: modeScan === "pulang" ? "Pulang" : "Masuk",
                    nama: peserta.nama,
                    nis: peserta.id,
                    kelas: peserta.kelas,
                    kategori: peserta.tipe,
                    waktu: wita.waktuFormatted,
                    message: `Selamat datang, ${peserta.nama}! Presensi MASUK berhasil dicatat.`
                }), { headers: corsHeaders });
            } else {
                // Sudah ada catatan hari ini
                const existing = logHariIni[0];
                if (modeScan === "masuk") {
                    return new Response(JSON.stringify({
                        status: "warning",
                        nama: peserta.nama,
                        nis: peserta.id,
                        kelas: peserta.kelas,
                        message: `${peserta.nama} sudah melakukan scan Masuk hari ini!`
                    }), { headers: corsHeaders });
                }

                // Update Kolom G (Pulang)
                const teksPulang = `Pulang (${wita.jamMenit})`;
                await sbFetch(`log_absen?id=eq.${existing.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ pulang: teksPulang })
                });

                return new Response(JSON.stringify({
                    status: "success",
                    tipe_absen: "Pulang",
                    nama: peserta.nama,
                    nis: peserta.id,
                    kelas: peserta.kelas,
                    kategori: peserta.tipe,
                    waktu: wita.waktuFormatted,
                    message: `Hati-hati di jalan, ${peserta.nama}! Presensi PULANG (${wita.jamMenit}) berhasil dicatat.`
                }), { headers: corsHeaders });
            }
        }

        // =====================================================================
        // 3. INPUT ABSEN MANUAL DARI PORTAL ADMIN
        // =====================================================================
        if (aksi === "absen_manual") {
            const nis = String(body.nis || "").trim();
            const nama = String(body.nama || "").trim();
            const status = String(body.status || "Izin").trim();
            const timestamp = String(body.timestamp || getWitaNow().waktuFormatted).trim();
            const tglPrefix = timestamp.split(" ")[0]; // DD/MM/YYYY
            const jamPart = (timestamp.split(" ")[1] || "07:00:00").substring(0, 5);
            const [dd, mm, yyyy] = tglPrefix.split("/");
            const tanggalISO = `${yyyy}-${mm}-${dd}`;

            // Cari info kelas/tipe
            let kelas = "-", tipe = "Siswa";
            const s = await sbFetch(`siswa?nis=eq.${encodeURIComponent(nis)}&select=kelas`);
            if (s.length > 0) {
                kelas = s[0].kelas;
            } else {
                const g = await sbFetch(`guru?nip=eq.${encodeURIComponent(nis)}&select=nip`);
                if (g.length > 0) { kelas = "Guru"; tipe = "Guru"; }
            }

            const existing = await sbFetch(
                `log_absen?nis_nip=eq.${encodeURIComponent(nis)}&waktu=like.${encodeURIComponent(tglPrefix)}*&select=*&order=id.desc&limit=1`
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

            // Masuk / Izin / Sakit
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

            return new Response(JSON.stringify({ status: "success", message: `Presensi ${status} untuk ${nama} berhasil disimpan ke Supabase!` }), { headers: corsHeaders });
        }

        // =====================================================================
        // 4. TAMBAH / IMPORT SISWA & GURU
        // =====================================================================
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

        // =====================================================================
        // 5. FITUR HAPUS DATA & RESTORE BACKUP
        // =====================================================================
        if (aksi === "hapus_siswa") {
            await sbFetch(`siswa?nis=eq.${encodeURIComponent(body.nis)}`, { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }
        if (aksi === "hapus_kelas_siswa") {
            await sbFetch(`siswa?kelas=eq.${encodeURIComponent(body.kelas)}`, { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }
        if (aksi === "hapus_semua_siswa") {
            await sbFetch("siswa?nis=neq.___KOSONG___", { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }
        if (aksi === "hapus_guru") {
            await sbFetch(`guru?nip=eq.${encodeURIComponent(body.nip)}`, { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }
        if (aksi === "hapus_semua_guru") {
            await sbFetch("guru?nip=neq.___KOSONG___", { method: "DELETE" });
            return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
        }
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
                waktu: String(r[0]).trim(),
                nama: String(r[1] || "").trim(),
                nis_nip: String(r[2] || "").trim(),
                kelas: String(r[3] || "-").trim(),
                status: String(r[4] || "Masuk").trim(),
                tipe: String(r[5] || "Siswa").trim(),
                pulang: String(r[6] || "").trim()
            }));

            if (siswaRows.length > 0) {
                await sbFetch("siswa?on_conflict=nis", {
                    method: "POST", headers: { "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify(siswaRows)
                });
            }
            if (guruRows.length > 0) {
                await sbFetch("guru?on_conflict=nip", {
                    method: "POST", headers: { "Prefer": "resolution=merge-duplicates" }, body: JSON.stringify(guruRows)
                });
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
