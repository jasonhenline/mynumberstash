-- Each catalog entry gets an equal share of the total special-card probability.
insert into public.special_cards (id, label, category) values
  ('e', 'e', 'constant'),
  ('phi', 'φ', 'constant'),
  ('i', 'i', 'imaginary'),
  ('sqrt2', '√2', 'irrational');
