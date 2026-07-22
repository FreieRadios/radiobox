cp ./ffmpeg-playout.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ffmpeg-playout.service
systemctl start ffmpeg-playout.service

sleep 5

journalctl -u ffmpeg-playout.service -f
