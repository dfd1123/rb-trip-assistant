#!/bin/bash
# deb·rpm 설치 후 (electron-builder 기본 스크립트 + 우분투 24.04 이상 대응)

if type update-alternatives 2>/dev/null >&1; then
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Chromium 샌드박스.
# 우분투 24.04 이상은 AppArmor 가 일반 사용자의 user namespace 를 막는다. 기본 스크립트는 root 로 테스트해서
# '된다'고 보고 SUID 를 빼 버리는데, 실제 사용자로 켜면 샌드박스를 못 만들어 아무 반응 없이 꺼진다.
# → ① AppArmor 프로필로 이 앱에만 user namespace 허용 (크롬·VS Code 와 같은 방식) ② 안 되면 쓰는 SUID 샌드박스도 켜 둔다.
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1; then
    PROFILE=/etc/apparmor.d/${executable}
    {
        [ -f /etc/apparmor.d/abi/4.0 ] && echo 'abi <abi/4.0>,'
        echo 'include <tunables/global>'
        echo 'profile ${executable} "/opt/${sanitizedProductName}/${executable}" flags=(unconfined) {'
        echo '  userns,'
        echo '  include if exists <local/${executable}>'
        echo '}'
    } > "$PROFILE"
    apparmor_parser -r "$PROFILE" 2>/dev/null || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
