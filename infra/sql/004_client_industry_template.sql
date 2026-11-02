alter table clients
add column if not exists industry_template text not null default 'coffee_shop';

update clients
set industry_template = 'coffee_shop'
where industry_template is null;
