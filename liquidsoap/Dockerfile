FROM savonet/liquidsoap:rolling-release-v2.2.x-minimal

USER root

RUN mkdir -p /home/liquidsoap/radio

COPY radiobox.liq /home/liquidsoap/radio
COPY output.liq /home/liquidsoap/radio
COPY var.liq /home/liquidsoap/radio

USER liquidsoap

CMD ["liquidsoap", "/home/liquidsoap/radio/radiobox.liq"]
