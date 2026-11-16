export async function onRequest(context) {
  const { request, env } = context;

  // Header CORS agar bisa diakses dari halaman Admin maupun halaman Scanner
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json;charset=utf-8"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ status: "error", message: "Gunakan method POST" }), { headers: corsHeaders });
  }

  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  // Helper untuk memanggil REST API Supabase
  const sbFetch = async (endpoint, options = {}) => {
    const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Supabase Error (${res.status}): ${errText}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  // Helper konversi "DD/MM/YYYY HH:mm:ss" atau "YYYY-MM-DD" ke "YYYY-MM-DD"
  const extractDateYMD = (rawStr) => {
    if (!rawStr) return new Date().toISOString().split("T")[0];
    const str = rawStr.toString().trim().replace(/^'/, "");
    const mDMY = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (mDMY) return `${mDMY[3]}-${mDMY[2].padStart(2, "0")}-${mDMY[1].padStart(2, "0")}`;
    const mYMD = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (mYMD) return `${mYMD[1]}-${mYMD[2].padStart(2, "0")}-${mYMD[3].padStart(2, "0")}`;
    return new Date().toISOString().split("T")[0];
  };

  try {
    const body = await request.json();
    const aksi = body.aksi;

    // =====================================================================
    // 1. GET DATA (Konversi ke Array 2D agar kompatibel dengan HTML lama)
    // =====================================================================
    if (aksi === "get_data") {
      const [siswaData, guruData, absenData] = await Promise.all([
        sbFetch("siswa?select=nis,nama,kelas&order=kelas.asc,nama.asc"),
        sbFetch("guru?select=nip,nama,rfid&order=nama.asc"),
        sbFetch("log_absen?select=waktu,nama,nis_nip,kelas_jabatan,status_masuk,tipe,status_pulang&order=id.asc")
      ]);

      const siswaAoA = [["NIS", "Nama", "Kelas"], ...siswaData.map(s => [s.nis, s.nama, s.kelas])];
      const guruAoA = [["NIP", "Nama", "RFID"], ...guruData.map(g => [g.nip, g.nama, g.rfid || "-"])];
      const absenAoA = [
        ["Waktu", "Nama", "NIS/NIP", "Kelas/Jabatan", "Status", "Tipe", "Pulang"],
        ...absenData.map(a => [a.waktu, a.nama, a.nis_nip, a.kelas_jabatan, a.status_masuk, a.tipe, a.status_pulang || ""])
      ];

      return new Response(JSON.stringify({
        status: "success",
        siswa: siswaAoA,
        guru: guruAoA,
        absen: absenAoA
      }), { headers: corsHeaders });
    }

    // =====================================================================
    // 2. IMPORT SISWA & GURU (Upsert Massal)
    // =====================================================================
    if (aksi === "import_siswa") {
      const payload = (body.siswaList || []).map(s => ({
        nis: String(s.nis).trim(),
        nama: String(s.nama).trim(),
        kelas: String(s.kelas).trim()
      }));
      if (payload.length > 0) {
        await sbFetch("siswa?on_conflict=nis", {
          method: "POST",
          headers: { "Prefer": "resolution=merge-duplicates" },
          body: JSON.stringify(payload)
        });
      }
      return new Response(JSON.stringify({ status: "success", message: `${payload.length} siswa disimpan.` }), { headers: corsHeaders });
    }

    if (aksi === "import_guru") {
      const payload = (body.guruList || []).map(g => ({
        nip: String(g.nip).trim(),
        nama: String(g.nama).trim(),
        rfid: String(g.rfid || "-").trim()
      }));
      if (payload.length > 0) {
        await sbFetch("guru?on_conflict=nip", {
          method: "POST",
          headers: { "Prefer": "resolution=merge-duplicates" },
          body: JSON.stringify(payload)
        });
      }
      return new Response(JSON.stringify({ status: "success", message: `${payload.length} guru disimpan.` }), { headers: corsHeaders });
    }

    // =====================================================================
    // 3. ABSEN MANUAL (Masuk / Izin / Sakit ke Kolom E, Pulang ke Kolom G)
    // =====================================================================
    if (aksi === "absen_manual") {
      const id = String(body.nis).trim();
      const status = body.status; // Masuk | Pulang | Izin | Sakit | Reset_Pulang
      const timestamp = body.timestamp; // "DD/MM/YYYY HH:mm:00"
      const tanggal = extractDateYMD(timestamp);
      const jamMenit = (timestamp.split(" ")[1] || "00:00").substring(0, 5);

      // Cari profil di tabel siswa atau guru
      let nama = body.nama || "-";
      let kelasJabatan = "-";
      let tipe = "Siswa";

      const cekSiswa = await sbFetch(`siswa?nis=eq.${encodeURIComponent(id)}&select=*`);
      if (cekSiswa && cekSiswa.length > 0) {
        nama = cekSiswa[0].nama;
        kelasJabatan = cekSiswa[0].kelas;
        tipe = "Siswa";
      } else {
        const cekGuru = await sbFetch(`guru?nip=eq.${encodeURIComponent(id)}&select=*`);
        if (cekGuru && cekGuru.length > 0) {
          nama = cekGuru[0].nama;
          kelasJabatan = "Guru";
          tipe = "Guru";
        }
      }

      // Cek apakah sudah ada baris absen pada tanggal tersebut
      const existing = await sbFetch(`log_absen?tanggal=eq.${tanggal}&nis_nip=eq.${encodeURIComponent(id)}&select=*`);

      if (status === "Pulang") {
        const labelPulang = `Pulang (${jamMenit})`;
        if (existing && existing.length > 0) {
          await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ status_pulang: labelPulang })
          });
        } else {
          await sbFetch("log_absen", {
            method: "POST",
            body: JSON.stringify({
              tanggal, waktu: timestamp, nama, nis_nip: id,
              kelas_jabatan: kelasJabatan, status_masuk: "Masuk",
              tipe, status_pulang: labelPulang
            })
          });
        }
      } else if (status === "Reset_Pulang") {
        if (existing && existing.length > 0) {
          await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ status_pulang: "" })
          });
        }
      } else {
        // Masuk, Izin, atau Sakit
        if (existing && existing.length > 0) {
          await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ waktu: timestamp, status_masuk: status })
          });
        } else {
          await sbFetch("log_absen", {
            method: "POST",
            body: JSON.stringify({
              tanggal, waktu: timestamp, nama, nis_nip: id,
              kelas_jabatan: kelasJabatan, status_masuk: status,
              tipe, status_pulang: ""
            })
          });
        }
      }

      return new Response(JSON.stringify({ status: "success", message: `Presensi ${nama} (${status}) berhasil disimpan.` }), { headers: corsHeaders });
    }

    // =====================================================================
    // 4. HAPUS DATA (Per Siswa/Guru, Per Kelas, & Kosongkan Semua)
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
      await sbFetch("siswa?nis=neq.__EMPTY__", { method: "DELETE" });
      return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
    }

    if (aksi === "hapus_guru") {
      await sbFetch(`guru?nip=eq.${encodeURIComponent(body.nip)}`, { method: "DELETE" });
      return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
    }

    if (aksi === "hapus_semua_guru") {
      await sbFetch("guru?nip=neq.__EMPTY__", { method: "DELETE" });
      return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
    }

    if (aksi === "hapus_semua_data") {
      await Promise.all([
        sbFetch("siswa?nis=neq.__EMPTY__", { method: "DELETE" }),
        sbFetch("guru?nip=neq.__EMPTY__", { method: "DELETE" }),
        sbFetch("log_absen?id=gt.0", { method: "DELETE" })
      ]);
      return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
    }

    // =====================================================================
    // 5. RESTORE ALL (Dari Menu Backup & Restore JSON/Excel)
    // =====================================================================
    if (aksi === "restore_all") {
      if (body.mode === "replace") {
        await Promise.all([
          sbFetch("siswa?nis=neq.__EMPTY__", { method: "DELETE" }),
          sbFetch("guru?nip=neq.__EMPTY__", { method: "DELETE" }),
          sbFetch("log_absen?id=gt.0", { method: "DELETE" })
        ]);
      }

      const rawSiswa = (body.siswa || []).slice(1).filter(r => r && r[0]);
      const rawGuru = (body.guru || []).slice(1).filter(r => r && r[0]);
      const rawAbsen = (body.absen || []).slice(1).filter(r => r && r[0]);

      if (rawSiswa.length > 0) {
        const siswaPayload = rawSiswa.map(r => ({
          nis: String(r[0]).trim().replace(/^'/, ""),
          nama: String(r[1] || "").trim(),
          kelas: String(r[2] || "-").trim()
        }));
        await sbFetch("siswa?on_conflict=nis", {
          method: "POST",
          headers: { "Prefer": "resolution=merge-duplicates" },
          body: JSON.stringify(siswaPayload)
        });
      }

      if (rawGuru.length > 0) {
        const guruPayload = rawGuru.map(r => ({
          nip: String(r[0]).trim().replace(/^'/, ""),
          nama: String(r[1] || "").trim(),
          rfid: String(r[2] || "-").trim().replace(/^'/, "")
        }));
        await sbFetch("guru?on_conflict=nip", {
          method: "POST",
          headers: { "Prefer": "resolution=merge-duplicates" },
          body: JSON.stringify(guruPayload)
        });
      }

      if (rawAbsen.length > 0) {
        const absenPayload = rawAbsen.map(r => ({
          tanggal: extractDateYMD(r[0]),
          waktu: String(r[0]).trim().replace(/^'/, ""),
          nama: String(r[1] || "-").trim(),
          nis_nip: String(r[2] || "-").trim().replace(/^'/, ""),
          kelas_jabatan: String(r[3] || "-").trim(),
          status_masuk: String(r[4] || "Masuk").trim(),
          tipe: String(r[5] || (r[3] === "Guru" ? "Guru" : "Siswa")).trim(),
          status_pulang: String(r[6] || "").trim().replace(/^'/, "")
        }));
        await sbFetch("log_absen?on_conflict=tanggal,nis_nip", {
          method: "POST",
          headers: { "Prefer": "resolution=merge-duplicates" },
          body: JSON.stringify(absenPayload)
        });
      }

      return new Response(JSON.stringify({ status: "success", message: "Database berhasil dipulihkan ke Supabase!" }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ status: "error", message: `Aksi '${aksi}' tidak dikenali.` }), { headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: err.message }), { headers: corsHeaders });
  }
}