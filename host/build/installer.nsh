; Add a Windows Firewall rule at install time: only Tailscale addresses
; (100.64.0.0/10, fd7a:115c:a1e0::/48) may connect to RD Host's built-in signaling server.
; Having a rule for the program also prevents the firewall prompt on first launch.

!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="RD Host (Tailscale)"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="RD Host (Tailscale)" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" remoteip=100.64.0.0/10,fd7a:115c:a1e0::/48 profile=any enable=yes'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="RD Host (Tailscale)"'
!macroend
