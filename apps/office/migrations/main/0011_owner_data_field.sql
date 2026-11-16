-- オーナーの情報は拡張と項目で 1 行だけにする。置き換えの消して足すが同時に来ても 2 行にならない (サービスと拡張の 3.8)
CREATE UNIQUE INDEX `owner_data_field` ON `owner_data` (`ext_id`,`field`);
