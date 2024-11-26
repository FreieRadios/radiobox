FROM savonet/liquidsoap:rolling-release-v2.2.x-minimal

USER root

RUN mkdir -p /home/liquidsoap/radio

COPY radio /home/liquidsoap/radio
COPY .env /home/liquidsoap/radio
USER liquidsoap

CMD ["liquidsoap", "/home/liquidsoap/radio/radiobox.liq"]
