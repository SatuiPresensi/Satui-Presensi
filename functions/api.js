export async function onRequest(context) {
  const { request, env } = context;

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

    if (aksi === "get_data") {
      const [siswaData, guruData, absenData] = await Promise.all([
        sbFetch("siswa?select=nis,nama,kelas&order=kelas.asc,nama.asc"),
        sbFetch("guru?select=nip,nama,rfid&order=nama.asc"),
        sbFetch("log_absen?select=waktu,nama,nis_nip,kelas_jabatan,status,tipe,pulang&order=id.asc")
      ]);

      const siswaAoA = [["NIS", "Nama", "Kelas"], ...siswaData.map(s => [s.nis, s.nama, s.kelas])];
      const guruAoA = [["NIP", "Nama", "RFID"], ...guruData.map(g => [g.nip, g.nama, g.rfid || "-"])];
      const absenAoA = [
        ["Waktu", "Nama", "NIS/NIP", "Kelas/Jabatan", "Status", "Tipe", "Pulang"],
        ...absenData.map(a => [a.waktu, a.nama, a.nis_nip, a.kelas_jabatan, a.status, a.tipe, a.pulang || ""])
      ];

      return new Response(JSON.stringify({ status: "success", siswa: siswaAoA, guru: guruAoA, absen: absenAoA }), { headers: corsHeaders });
    }

    if (aksi === "import_siswa") {
      const payload = (body.siswaList || []).map(s => ({
        nis: String(s.nis).trim().replace(/^'/, ""),
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
      return new Response(JSON.stringify({ status: "success", message: `${payload.length} siswa berhasil disimpan.` }), { headers: corsHeaders });
    }

    if (aksi === "import_guru") {
      const payload = (body.guruList || []).map(g => ({
        nip: String(g.nip).trim().replace(/^'/, ""),
        nama: String(g.nama).trim(),
        rfid: String(g.rfid || "-").trim().replace(/^'/, "")
      }));
      if (payload.length > 0) {
        await sbFetch("guru?on_conflict=nip", {
          method: "POST",
          headers: { "Prefer": "resolution=merge-duplicates" },
          body: JSON.stringify(payload)
        });
      }
      return new Response(JSON.stringify({ status: "success", message: `${payload.length} guru berhasil disimpan.` }), { headers: corsHeaders });
    }

    if (aksi === "absen_manual") {
      const id = String(body.nis).trim();
      const statusInp = body.status; 
      const timestamp = body.timestamp; 
      const tanggal = extractDateYMD(timestamp);
      const jamMenit = (timestamp.split(" ")[1] || "00:00").substring(0, 5);

      let nama = body.nama || "-";
      let kelasJabatan = "-";
      let tipe = "Siswa";

      const cekSiswa = await sbFetch(`siswa?nis=eq.${encodeURIComponent(id)}&select=*`);
      if (cekSiswa && cekSisaOrArrayLen(cekSiswa)) {
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

      const existing = await sbFetch(`log_absen?tanggal=eq.${tanggal}&nis_nip=eq.${encodeURIComponent(id)}&select=*`);

      if (statusInp === "Pulang") {
        const labelPulang = `Pulang (${jamMenit})`;
        if (existing && existing.length > 0) {
          await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ pulang: labelPulang })
          });
        } else {
          await sbFetch("log_absen", {
            method: "POST",
            body: JSON.stringify({
              tanggal, waktu: timestamp, nama, nis_nip: id,
              kelas_jabatan: kelasJabatan, status: "Masuk",
              tipe, pulang: labelPulang
            })
          });
        }
      } else if (statusInp === "Reset_Pulang") {
        if (existing && existing.length > 0) {
          await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ pulang: "" })
          });
        }
      } else {
        if (existing && existing.length > 0) {
          await sbFetch(`log_absen?id=eq.${existing[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ waktu: timestamp, status: statusInp })
          });
        } else {
          await sbFetch("log_absen", {
            method: "POST",
            body: JSON.stringify({
              tanggal, waktu: timestamp, nama, nis_nip: id,
              kelas_jabatan: kelasJabatan, status: statusInp,
              tipe, pulang: ""
            })
          });
        }
      }

      return new Response(JSON.stringify({ status: "success", message: `Presensi ${nama} berhasil disimpan.` }), { headers: corsHeaders });
    }

    if (aksi === "hapus_siswa") {
      await sbFetch(`siswa?nis=eq.${encodeURIComponent(body.nis)}`, { method: "DELETE" });
      return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
    }

    if (aksi === "hapus_semua_siswa") {
      await sbFetch("siswa?nis=neq.__EMPTY__", { method: "DELETE" });
      return new Response(JSON.stringify({ status: "success" }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ status: "error", message: `Aksi tidak dikenal.` }), { headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: err.message }), { headers: corsHeaders });
  }
}
