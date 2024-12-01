FROM savonet/liquidsoap:v2.2.5

USER root

RUN mkdir -p /home/liquidsoap/radio

COPY radiobox.liq /home/liquidsoap/radio
COPY radiobox-light.liq /home/liquidsoap/radio
COPY var.liq /home/liquidsoap/radio

USER liquidsoap

CMD ["liquidsoap", "/home/liquidsoap/radio/radiobox-light.liq"]
