FROM savonet/liquidsoap:v2.2.5

USER root

RUN mkdir -p /home/liquidsoap/radio
RUN mkdir -p /tmp/liquidsoap/logs

COPY radiobox.liq /home/liquidsoap/radio
COPY mounts.liq /home/liquidsoap/radio
COPY var.liq /home/liquidsoap/radio
COPY tools /home/liquidsoap/radio/tools

USER liquidsoap

CMD ["liquidsoap", "/home/liquidsoap/radio/radiobox.liq"]
