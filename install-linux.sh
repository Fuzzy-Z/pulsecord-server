#!/usr/bin/env bash
# ==============================================================================
# Voxel - Script de Instalação Automática para Linux (x86_64)
# Site Oficial: https://voxelchat.com.br | App: https://app.voxelchat.com.br
# ==============================================================================

set -e

VOXEL_VERSION="1.0.127"
TAR_URL="https://app.voxelchat.com.br/download/linux/Voxel-${VOXEL_VERSION}-x64.tar.gz"
ICON_URL="https://app.voxelchat.com.br/icon.png"

# Cores do terminal
BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "  __     __              _ "
echo "  \ \   / /____  _____ _| |"
echo "   \ \ / / _ \ \/ / _ \ | |"
echo "    \ V / (_) >  <  __/ |_|"
echo "     \_/ \___/_/\_\___|_(_)"
echo -e "${NC}"
echo -e "${BOLD}Instalador Oficial do Voxel Desktop para Linux (v${VOXEL_VERSION})${NC}"
echo "---------------------------------------------------------"

# 1. Checagem de arquitetura
ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ]; then
    echo -e "${RED}❌ Arquitetura detectada: $ARCH${NC}"
    echo "O Voxel Linux Desktop está disponível atualmente para sistemas x86_64 (64-bit)."
    exit 1
fi

# 2. Determinar permissões e diretórios de destino
if [ "$EUID" -eq 0 ]; then
    INSTALL_DIR="/opt/voxel"
    BIN_DIR="/usr/local/bin"
    DESKTOP_DIR="/usr/share/applications"
    ICON_DIR="/usr/share/icons/hicolor/512x512/apps"
    USE_SUDO=""
else
    INSTALL_DIR="$HOME/.local/share/voxel"
    BIN_DIR="$HOME/.local/bin"
    DESKTOP_DIR="$HOME/.local/share/applications"
    ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
    mkdir -p "$BIN_DIR"
fi

echo -e "${CYAN}==>${NC} Destino da instalação: ${BOLD}${INSTALL_DIR}${NC}"

# 3. Baixar pacote
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo -e "${CYAN}==>${NC} Baixando o Voxel v${VOXEL_VERSION}..."
if command -v curl >/dev/null 2>&1; then
    curl -fSL --progress-bar "$TAR_URL" -o "$TMP_DIR/voxel.tar.gz"
elif command -v wget >/dev/null 2>&1; then
    wget --show-progress -qO "$TMP_DIR/voxel.tar.gz" "$TAR_URL"
else
    echo -e "${RED}❌ Nem curl nem wget foram encontrados. Por favor instale um deles para continuar.${NC}"
    exit 1
fi

# 4. Extrair arquivos
echo -e "${CYAN}==>${NC} Extraindo binários..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP_DIR/voxel.tar.gz" --strip-components=1 -C "$INSTALL_DIR"

# Garantir permissão de execução
chmod +x "$INSTALL_DIR/pulsecord"
if [ -f "$INSTALL_DIR/chrome-sandbox" ]; then
    if [ "$EUID" -eq 0 ]; then
        chown root:root "$INSTALL_DIR/chrome-sandbox" 2>/dev/null || true
        chmod 4755 "$INSTALL_DIR/chrome-sandbox" 2>/dev/null || true
    else
        chmod +x "$INSTALL_DIR/chrome-sandbox" 2>/dev/null || true
    fi
fi

# 5. Criar script launcher inteligente (gerencia sandbox do Chromium sem travar)
cat << 'EOF' > "$INSTALL_DIR/voxel-launcher.sh"
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="$DIR/chrome-sandbox"

# Se o chrome-sandbox tiver permissão SUID root (4755), executa normal; caso contrário, ativa --no-sandbox
if [ -f "$SANDBOX" ] && [ -u "$SANDBOX" ] && [ "$(stat -c '%u' "$SANDBOX" 2>/dev/null)" = "0" ]; then
    exec "$DIR/pulsecord" "$@"
else
    exec "$DIR/pulsecord" --no-sandbox "$@"
fi
EOF
chmod +x "$INSTALL_DIR/voxel-launcher.sh"

echo -e "${CYAN}==>${NC} Configurando atalho no terminal..."
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/voxel-launcher.sh" "$BIN_DIR/voxel"

# 6. Instalar ícone
echo -e "${CYAN}==>${NC} Instalando ícone do aplicativo..."
mkdir -p "$ICON_DIR"
if [ -f "$INSTALL_DIR/resources/build/icon.png" ]; then
    cp "$INSTALL_DIR/resources/build/icon.png" "$ICON_DIR/voxel.png"
elif [ -f "$INSTALL_DIR/resources/public/icon.png" ]; then
    cp "$INSTALL_DIR/resources/public/icon.png" "$ICON_DIR/voxel.png"
else
    curl -sSL "$ICON_URL" -o "$ICON_DIR/voxel.png" 2>/dev/null || true
fi

# 7. Criar entrada no menu de aplicativos (.desktop)
echo -e "${CYAN}==>${NC} Criando lançador no menu de aplicativos..."
mkdir -p "$DESKTOP_DIR"
cat <<EOF > "$DESKTOP_DIR/voxel.desktop"
[Desktop Entry]
Name=Voxel
Comment=Voxel Desktop Client - Voz, Chat e Comunidades
Exec=$INSTALL_DIR/voxel-launcher.sh %U
Icon=voxel
Terminal=false
Type=Application
Categories=Network;Chat;InstantMessaging;AudioVideo;
StartupWMClass=pulsecord
MimeType=x-scheme-handler/voxel;
EOF

chmod +x "$DESKTOP_DIR/voxel.desktop"

# Atualizar caches do sistema de desktop se existirem
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "$ICON_DIR/../../.." 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}${BOLD}🎉 Voxel v${VOXEL_VERSION} instalado com sucesso no seu Linux!${NC}"
echo "---------------------------------------------------------"
echo -e "Você já pode:"
echo -e "  1. Abrir procurando por ${BOLD}Voxel${NC} no menu de aplicativos."
echo -e "  2. Ou digitar no terminal: ${CYAN}${BOLD}voxel${NC}"
echo ""
