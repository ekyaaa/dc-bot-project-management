export function renderLoginPage(errorMsg?: string): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login — Discord Project Bot</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: { 500: '#5865F2', 600: '#4752C4' }
          }
        }
      }
    }
  </script>
</head>
<body class="bg-slate-950 text-slate-100 flex items-center justify-center min-h-screen p-4">
  <div class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
    <div class="flex items-center justify-center mb-6">
      <div class="w-14 h-14 bg-brand-500/20 border border-brand-500/30 rounded-2xl flex items-center justify-center text-brand-500 font-bold text-2xl shadow-inner">
        ⚡
      </div>
    </div>
    <h1 class="text-2xl font-bold text-center mb-1">Bot Management HQ</h1>
    <p class="text-sm text-slate-400 text-center mb-6">Masuk untuk mengelola multi-project & permission server Discord</p>

    <div id="alertBox" class="${errorMsg ? '' : 'hidden'} mb-4 p-3.5 rounded-xl text-sm bg-rose-500/15 border border-rose-500/30 text-rose-300">
      ${errorMsg || ''}
    </div>

    <form id="loginForm" class="space-y-4">
      <div>
        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Username</label>
        <input type="text" id="username" name="username" required
          class="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-brand-500 transition-colors"
          placeholder="mashupsoat" value="mashupsoat">
      </div>

      <div>
        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Password</label>
        <input type="password" id="password" name="password" required
          class="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-brand-500 transition-colors"
          placeholder="••••••••••••">
      </div>

      <button type="submit" id="submitBtn"
        class="w-full bg-brand-500 hover:bg-brand-600 text-white font-medium py-2.5 px-4 rounded-xl transition duration-200 shadow-lg shadow-brand-500/25 flex items-center justify-center space-x-2">
        <span>Masuk ke Dashboard</span>
      </button>
    </form>
  </div>

  <script>
    const form = document.getElementById('loginForm');
    const alertBox = document.getElementById('alertBox');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>Memverifikasi...</span>';
      alertBox.classList.add('hidden');

      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      try {
        const res = await fetch('/admin/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (res.ok) {
          window.location.href = '/admin';
        } else {
          alertBox.textContent = data.error || 'Username atau password salah.';
          alertBox.classList.remove('hidden');
        }
      } catch (err) {
        alertBox.textContent = 'Gagal terhubung ke server.';
        alertBox.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Masuk ke Dashboard</span>';
      }
    });
  </script>
</body>
</html>`;
}

export function renderDashboardPage(username: string): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Discord Bot Multi-Project HQ</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: { 500: '#5865F2', 600: '#4752C4' }
          }
        }
      }
    }
  </script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans antialiased">
  <!-- Top Navigation -->
  <header class="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 bg-brand-500/20 border border-brand-500/30 rounded-xl flex items-center justify-center text-brand-500 font-bold text-xl">
          ⚡
        </div>
        <div>
          <h1 class="text-base font-bold leading-tight">Discord Bot HQ</h1>
          <p class="text-xs text-slate-400">Multi-Project & Server Permission Management</p>
        </div>
      </div>
      <div class="flex items-center space-x-4">
        <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse"></span>
          Running Native Node 22
        </span>
        <div class="text-xs text-slate-300 font-medium bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700">
          👤 ${username}
        </div>
        <button onclick="handleLogout()" class="text-xs text-slate-400 hover:text-rose-400 transition-colors font-medium">
          Logout
        </button>
      </div>
    </div>
  </header>

  <!-- Main Container -->
  <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
    <!-- Status Toast Notification -->
    <div id="toast" class="hidden fixed bottom-6 right-6 max-w-sm p-4 rounded-xl shadow-2xl border text-sm transition-all duration-300 z-50"></div>

    <!-- Overview Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
      <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
        <div class="text-xs uppercase tracking-wider font-semibold text-slate-400">Total Projects</div>
        <div class="mt-2 flex items-baseline justify-between">
          <div id="statProjectsCount" class="text-3xl font-extrabold text-white">-</div>
          <span class="text-xs text-brand-400 font-medium">GitHub Projects v2</span>
        </div>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
        <div class="text-xs uppercase tracking-wider font-semibold text-slate-400">Linked Discord Servers</div>
        <div class="mt-2 flex items-baseline justify-between">
          <div id="statGuildsCount" class="text-3xl font-extrabold text-white">-</div>
          <span class="text-xs text-emerald-400 font-medium">Isolated Guilds</span>
        </div>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
        <div class="text-xs uppercase tracking-wider font-semibold text-slate-400">Ingress Status</div>
        <div class="mt-2 flex items-baseline justify-between">
          <div class="text-xl font-bold text-indigo-400">Tailscale Funnel</div>
          <span class="text-xs text-slate-400">Port 3000 Active</span>
        </div>
      </div>
    </div>

    <!-- Section 1: Manage Projects -->
    <section class="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
      <div class="p-6 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 class="text-lg font-bold">1. Daftar Proyek GitHub</h2>
          <p class="text-xs text-slate-400 mt-0.5">Daftarkan repositori dan nomor GitHub Project board yang dapat dikelola bot.</p>
        </div>
        <button onclick="openProjectModal()" class="inline-flex items-center space-x-2 bg-brand-500 hover:bg-brand-600 text-white text-xs font-semibold px-4 py-2 rounded-xl transition shadow shadow-brand-500/20">
          <span>+ Tambah Proyek Baru</span>
        </button>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm text-slate-300">
          <thead class="bg-slate-950/60 text-xs uppercase tracking-wider text-slate-400 border-b border-slate-800">
            <tr>
              <th class="px-6 py-3.5 font-semibold">Project ID (Slug)</th>
              <th class="px-6 py-3.5 font-semibold">Nama Tampilan</th>
              <th class="px-6 py-3.5 font-semibold">GitHub Repo</th>
              <th class="px-6 py-3.5 font-semibold">Project #</th>
              <th class="px-6 py-3.5 font-semibold text-right">Aksi</th>
            </tr>
          </thead>
          <tbody id="projectsTableBody" class="divide-y divide-slate-800">
            <tr><td colspan="5" class="px-6 py-6 text-center text-slate-500 text-xs">Memuat data proyek...</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Section 2: Manage Server Permissions -->
    <section class="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
      <div class="p-6 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 class="text-lg font-bold">2. Hak Akses Server Discord (Guild Permissions)</h2>
          <p class="text-xs text-slate-400 mt-0.5">Atur Server ID Discord mana saja yang diizinkan mengakses proyek tertentu dan channel notifikasi defaultnya.</p>
        </div>
        <div class="flex items-center space-x-3">
          <a href="https://discord.com/oauth2/authorize?client_id=1567460119850262668&scope=bot%20applications.commands&permissions=277025507328" target="_blank" class="inline-flex items-center space-x-2 bg-slate-800 hover:bg-slate-700 text-indigo-300 text-xs font-semibold px-4 py-2 rounded-xl border border-slate-700 transition">
            <span>🔗 Invite Bot ke Server</span>
          </a>
          <button onclick="openPermissionModal()" class="inline-flex items-center space-x-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2 rounded-xl transition shadow shadow-emerald-600/20">
            <span>+ Tautkan Server ke Proyek</span>
          </button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm text-slate-300">
          <thead class="bg-slate-950/60 text-xs uppercase tracking-wider text-slate-400 border-b border-slate-800">
            <tr>
              <th class="px-6 py-3.5 font-semibold">Discord Guild ID (Server)</th>
              <th class="px-6 py-3.5 font-semibold">Proyek GitHub yang Diberi Izin</th>
              <th class="px-6 py-3.5 font-semibold">Default Channel Notifikasi</th>
              <th class="px-6 py-3.5 font-semibold">Status Default</th>
              <th class="px-6 py-3.5 font-semibold text-right">Aksi</th>
            </tr>
          </thead>
          <tbody id="permissionsTableBody" class="divide-y divide-slate-800">
            <tr><td colspan="5" class="px-6 py-6 text-center text-slate-500 text-xs">Memuat data permission server...</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <!-- Modal: Tambah / Edit Proyek -->
  <div id="projectModal" class="hidden fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl">
      <h3 id="projectModalTitle" class="text-lg font-bold mb-1">Tambah Proyek GitHub</h3>
      <p class="text-xs text-slate-400 mb-5">Pastikan GitHub App sudah diizinkan mengakses repositori ini di GitHub Settings.</p>

      <form id="projectForm" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1">Project ID / Slug (Unik, huruf kecil & strip)</label>
          <input type="text" id="p_id" required placeholder="misal: my-cool-project"
            class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-500">
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1">Nama Tampilan Proyek</label>
          <input type="text" id="p_name" required placeholder="misal: Mobile App Backend"
            class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-500">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-semibold text-slate-400 mb-1">GitHub Owner (Org/User)</label>
            <input type="text" id="p_owner" required placeholder="misal: Nexa-Code-Studio"
              class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-500">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-400 mb-1">GitHub Repository Name</label>
            <input type="text" id="p_repo" required placeholder="misal: eva-ecosystem"
              class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-500">
          </div>
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1">GitHub Project v2 Number</label>
          <input type="number" id="p_number" required placeholder="2"
            class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-500">
          <p class="text-[11px] text-slate-500 mt-1">Nomor proyek di URL GitHub: https://github.com/orgs/{org}/projects/{number}</p>
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1">Deskripsi Singkat (Opsional)</label>
          <input type="text" id="p_desc" placeholder="Proyek utama tim mobile"
            class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-500">
        </div>

        <div class="flex items-center justify-end space-x-3 pt-4 border-t border-slate-800">
          <button type="button" onclick="closeProjectModal()" class="px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-200">Batal</button>
          <button type="submit" class="px-4 py-2 text-xs font-semibold bg-brand-500 hover:bg-brand-600 text-white rounded-xl transition">Simpan Proyek</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Modal: Tautkan Server (Guild Permission) -->
  <div id="permissionModal" class="hidden fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl">
      <h3 class="text-lg font-bold mb-1">Tautkan Server Discord ke Proyek</h3>
      <p class="text-xs text-slate-400 mb-5">
        Pastikan bot sudah di-invite ke server tersebut terlebih dahulu sebelum melakukan sinkronisasi command.
        <a href="https://discord.com/oauth2/authorize?client_id=1567460119850262668&scope=bot%20applications.commands&permissions=277025507328" target="_blank" class="text-brand-400 underline font-medium">Klik di sini untuk Invite Bot ke Server</a>.
      </p>

      <form id="permissionForm" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1">Discord Guild ID (Server ID)</label>
          <input type="text" id="perm_guild_id" required placeholder="1374691978230366240"
            class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500">
          <p class="text-[11px] text-slate-500 mt-1">Dapatkan ID dengan klik kanan nama server di Discord > Copy Server ID.</p>
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1">Pilih Proyek GitHub</label>
          <select id="perm_project_id" required
            class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500">
          </select>
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1">Notification Channel ID (Opsional)</label>
          <input type="text" id="perm_channel_id" placeholder="1567466308789076048"
            class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500">
          <p class="text-[11px] text-slate-500 mt-1">Channel tujuan notifikasi issues & pull requests dari GitHub.</p>
        </div>

        <div class="flex items-center space-x-2 pt-1">
          <input type="checkbox" id="perm_is_default" checked
            class="w-4 h-4 rounded bg-slate-950 border-slate-700 text-brand-500 focus:ring-brand-500">
          <label for="perm_is_default" class="text-xs text-slate-300">Jadikan Proyek Utama (Default) untuk server ini</label>
        </div>

        <div class="flex items-center justify-end space-x-3 pt-4 border-t border-slate-800">
          <button type="button" onclick="closePermissionModal()" class="px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-200">Batal</button>
          <button type="submit" class="px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl transition">Simpan Hak Akses</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    let projectsCache = [];
    let permissionsCache = [];

    async function loadData() {
      try {
        const [pRes, gRes] = await Promise.all([
          fetch('/admin/api/projects'),
          fetch('/admin/api/permissions')
        ]);

        if (pRes.status === 401 || gRes.status === 401) {
          window.location.href = '/admin/login';
          return;
        }

        projectsCache = await pRes.json();
        permissionsCache = await gRes.json();

        renderProjects();
        renderPermissions();
        updateStats();
      } catch (err) {
        showToast('Gagal memuat data dari server.', 'error');
      }
    }

    function updateStats() {
      document.getElementById('statProjectsCount').textContent = projectsCache.length;
      const uniqueGuilds = new Set(permissionsCache.map(p => p.guild_id));
      document.getElementById('statGuildsCount').textContent = uniqueGuilds.size;
    }

    function renderProjects() {
      const tbody = document.getElementById('projectsTableBody');
      if (projectsCache.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500 text-xs">Belum ada proyek yang didaftarkan.</td></tr>';
        return;
      }

      tbody.innerHTML = projectsCache.map(p => \`
        <tr class="hover:bg-slate-800/40 transition">
          <td class="px-6 py-4 font-mono text-xs text-brand-400 font-medium">\${p.id}</td>
          <td class="px-6 py-4 font-semibold text-slate-100">
            \${p.name}
            \${p.description ? \`<div class="text-[11px] text-slate-500 font-normal mt-0.5">\${p.description}</div>\` : ''}
          </td>
          <td class="px-6 py-4 font-mono text-xs text-slate-300">\${p.github_owner}/\${p.github_repo}</td>
          <td class="px-6 py-4 text-xs font-medium text-amber-400">#\${p.project_number}</td>
          <td class="px-6 py-4 text-right space-x-2">
            <button onclick="editProject('\${p.id}')" class="text-xs text-slate-400 hover:text-slate-200">Edit</button>
            <button onclick="deleteProject('\${p.id}')" class="text-xs text-rose-400 hover:text-rose-300">Hapus</button>
          </td>
        </tr>
      \`).join('');

      // Populate project dropdown in permission modal
      const select = document.getElementById('perm_project_id');
      select.innerHTML = projectsCache.map(p => \`
        <option value="\${p.id}">\${p.name} (\${p.github_owner}/\${p.github_repo})</option>
      \`).join('');
    }

    function renderPermissions() {
      const tbody = document.getElementById('permissionsTableBody');
      if (permissionsCache.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-slate-500 text-xs">Belum ada server yang ditautkan ke proyek.</td></tr>';
        return;
      }

      tbody.innerHTML = permissionsCache.map(perm => \`
        <tr class="hover:bg-slate-800/40 transition">
          <td class="px-6 py-4 font-mono text-xs text-slate-200 font-semibold">\${perm.guild_id}</td>
          <td class="px-6 py-4">
            <div class="font-medium text-slate-200">\${perm.project_name || perm.project_id}</div>
            <div class="font-mono text-[11px] text-slate-500">\${perm.github_owner}/\${perm.github_repo}</div>
          </td>
          <td class="px-6 py-4 font-mono text-xs text-slate-400">\${perm.notification_channel_id || '<span class="text-slate-600">Tidak diatur</span>'}</td>
          <td class="px-6 py-4">
            \${perm.is_default 
              ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">DEFAULT</span>' 
              : '<span class="text-slate-600 text-xs">-</span>'}
          </td>
          <td class="px-6 py-4 text-right space-x-3">
            <button onclick="syncCommands('\${perm.guild_id}')" class="text-xs text-indigo-400 hover:text-indigo-300 font-medium">Sync Commands</button>
            <button onclick="deletePermission('\${perm.guild_id}', '\${perm.project_id}')" class="text-xs text-rose-400 hover:text-rose-300">Hapus</button>
          </td>
        </tr>
      \`).join('');
    }

    // Modal Handlers
    function openProjectModal(editId = null) {
      document.getElementById('projectForm').reset();
      document.getElementById('p_id').disabled = false;
      document.getElementById('projectModalTitle').textContent = 'Tambah Proyek GitHub';

      if (editId) {
        const p = projectsCache.find(x => x.id === editId);
        if (p) {
          document.getElementById('projectModalTitle').textContent = 'Edit Proyek GitHub';
          document.getElementById('p_id').value = p.id;
          document.getElementById('p_id').disabled = true;
          document.getElementById('p_name').value = p.name;
          document.getElementById('p_owner').value = p.github_owner;
          document.getElementById('p_repo').value = p.github_repo;
          document.getElementById('p_number').value = p.project_number;
          document.getElementById('p_desc').value = p.description || '';
        }
      }
      document.getElementById('projectModal').classList.remove('hidden');
    }

    function closeProjectModal() {
      document.getElementById('projectModal').classList.add('hidden');
    }

    function openPermissionModal() {
      document.getElementById('permissionForm').reset();
      document.getElementById('permissionModal').classList.remove('hidden');
    }

    function closePermissionModal() {
      document.getElementById('permissionModal').classList.add('hidden');
    }

    // Form Submissions
    document.getElementById('projectForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        id: document.getElementById('p_id').value,
        name: document.getElementById('p_name').value,
        github_owner: document.getElementById('p_owner').value,
        github_repo: document.getElementById('p_repo').value,
        project_number: parseInt(document.getElementById('p_number').value, 10),
        description: document.getElementById('p_desc').value || null
      };

      try {
        const res = await fetch('/admin/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          showToast('Proyek berhasil disimpan!', 'success');
          closeProjectModal();
          await loadData();
        } else {
          const err = await res.json();
          showToast(err.error || 'Gagal menyimpan proyek.', 'error');
        }
      } catch {
        showToast('Kesalahan jaringan.', 'error');
      }
    });

    document.getElementById('permissionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        guild_id: document.getElementById('perm_guild_id').value,
        project_id: document.getElementById('perm_project_id').value,
        notification_channel_id: document.getElementById('perm_channel_id').value || null,
        is_default: document.getElementById('perm_is_default').checked
      };

      try {
        const res = await fetch('/admin/api/permissions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          showToast('Izin server berhasil ditautkan!', 'success');
          closePermissionModal();
          await loadData();
        } else {
          const err = await res.json();
          showToast(err.error || 'Gagal menautkan izin.', 'error');
        }
      } catch {
        showToast('Kesalahan jaringan.', 'error');
      }
    });

    async function deleteProject(id) {
      if (!confirm(\`Apakah kamu yakin ingin menghapus proyek "\${id}"? Semua izin server ke proyek ini akan ikut terhapus.\`)) return;
      try {
        const res = await fetch(\`/admin/api/projects/\${id}\`, { method: 'DELETE' });
        if (res.ok) {
          showToast('Proyek berhasil dihapus.', 'success');
          await loadData();
        }
      } catch {
        showToast('Gagal menghapus proyek.', 'error');
      }
    }

    async function deletePermission(guildId, projectId) {
      if (!confirm('Hapus hak akses server ini ke proyek?')) return;
      try {
        const res = await fetch(\`/admin/api/permissions/\${guildId}/\${projectId}\`, { method: 'DELETE' });
        if (res.ok) {
          showToast('Hak akses berhasil dihapus.', 'success');
          await loadData();
        }
      } catch {
        showToast('Gagal menghapus hak akses.', 'error');
      }
    }

    async function syncCommands(guildId) {
      showToast(\`Mendaftarkan slash commands ke server \${guildId}...\`, 'info');
      try {
        const res = await fetch(\`/admin/api/sync-commands/\${guildId}\`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showToast(\`Sukses mendaftarkan \${data.registeredCount} commands ke server!\`, 'success');
        } else {
          showToast(data.error || 'Gagal sinkronisasi command.', 'error');
        }
      } catch {
        showToast('Kesalahan jaringan saat sync commands.', 'error');
      }
    }

    function editProject(id) {
      openProjectModal(id);
    }

    async function handleLogout() {
      await fetch('/admin/api/logout', { method: 'POST' });
      window.location.href = '/admin/login';
    }

    function showToast(msg, type = 'info') {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.className = 'fixed bottom-6 right-6 max-w-sm p-4 rounded-xl shadow-2xl border text-sm transition-all duration-300 z-50 ' +
        (type === 'success' ? 'bg-emerald-950 border-emerald-500/30 text-emerald-300' :
         type === 'error' ? 'bg-rose-950 border-rose-500/30 text-rose-300' :
         'bg-slate-900 border-slate-700 text-slate-200');
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 4000);
    }

    loadData();
  </script>
</body>
</html>`;
}
