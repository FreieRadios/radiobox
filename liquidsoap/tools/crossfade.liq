# Crossfade-Transition (2s): blendet die alte Quelle aus und die neue ein.
# Wird vom switch sowohl beim Wechsel zu interval_repeat als auch zu
# interval_live genutzt.
def crossfade_transition(old, new) =
  add(normalize=false, [
    fade.initial(duration=2., new),
    fade.final(duration=2., old)
  ])
end
