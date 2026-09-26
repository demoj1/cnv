#!/usr/bin/env bash
# Ставит собранный AppImage в систему для текущего пользователя: сам бинарь, иконку,
# пункт меню и ассоциацию с .canvas. Без sudo, всё в ~/.local.
#
#   npm run build:linux && scripts/install-desktop.sh
#   scripts/install-desktop.sh --uninstall
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${HOME}/.local/bin"
data_dir="${XDG_DATA_HOME:-${HOME}/.local/share}"
apps_dir="${data_dir}/applications"
icon_dir="${data_dir}/icons/hicolor/512x512/apps"
mime_dir="${data_dir}/mime/packages"

target="${bin_dir}/cnv.AppImage"
desktop="${apps_dir}/cnv.desktop"
icon="${icon_dir}/cnv.png"
mime="${mime_dir}/cnv-jsoncanvas.xml"

refresh() {
  command -v update-desktop-database >/dev/null && update-desktop-database "${apps_dir}" || true
  command -v update-mime-database >/dev/null && update-mime-database "${data_dir}/mime" || true
  command -v gtk-update-icon-cache >/dev/null &&
    gtk-update-icon-cache -f -t "${data_dir}/icons/hicolor" 2>/dev/null || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -fv "${target}" "${desktop}" "${icon}" "${mime}"
  refresh
  echo "удалено"
  exit 0
fi

appimage="$(ls -t "${root}"/release/*.AppImage 2>/dev/null | head -1 || true)"
if [[ -z "${appimage}" ]]; then
  echo "AppImage не найден в ${root}/release — сначала: npm run build:linux" >&2
  exit 1
fi

mkdir -p "${bin_dir}" "${apps_dir}" "${icon_dir}" "${mime_dir}"
install -m 755 "${appimage}" "${target}"
install -m 644 "${root}/build/icon.png" "${icon}"

# Ассоциация .canvas: без своего MIME-типа система не знает, чем открывать такие файлы.
cat > "${mime}" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-jsoncanvas">
    <comment>JSON Canvas</comment>
    <comment xml:lang="ru">Холст JSON Canvas</comment>
    <!-- вес выше стандартного 50: иначе содержимое опознаётся как обычный JSON -->
    <glob pattern="*.canvas" weight="80"/>
    <!-- .canvas это JSON: без sub-class-of содержимое опознаётся как application/json
         и побеждает маску имени -->
    <sub-class-of type="application/json"/>
    <icon name="cnv"/>
  </mime-type>
</mime-info>
XML

cat > "${desktop}" <<XML
[Desktop Entry]
Type=Application
Name=cnv
GenericName=Бесконечный холст
Comment=Скретчпад: markdown-карточки, картинки, PDF и живые веб-страницы
Exec=${target} %U
Icon=cnv
Terminal=false
Categories=Office;
MimeType=application/x-jsoncanvas;
Keywords=canvas;холст;скретчпад;заметки;notes;
StartupWMClass=cnv
XML

refresh

if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "${desktop}" && echo "desktop-файл валиден"
fi

echo "поставлено:"
echo "  ${target}"
echo "  ${desktop}"
echo "  ${icon}"
echo "  ${mime}"
