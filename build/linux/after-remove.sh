#!/bin/bash
# deb·rpm 제거 후: 실행 링크와 AppArmor 프로필 정리

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

if [ -f /etc/apparmor.d/${executable} ]; then
    apparmor_parser -R /etc/apparmor.d/${executable} 2>/dev/null || true
    rm -f /etc/apparmor.d/${executable}
fi
